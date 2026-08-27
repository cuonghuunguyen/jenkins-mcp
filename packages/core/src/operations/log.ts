/**
 * Build console log reads (READ-10, READ-11).
 *
 * This is the tool an agent reaches for most, so the contract that matters is
 * not feature count but *bounded* output: every mode returns a window of the
 * log, every window carries the ORIGINAL line numbers so the agent can ask for
 * a neighbouring range next, and `save_to` exists so a multi-megabyte log can
 * be captured to disk without ever entering a context window.
 *
 * Five modes, one fetch strategy:
 *
 * - `tail`   - the last N lines. The default, because a caller looking at a
 *              failure wants the end.
 * - `grep`   - regex matches plus context, grouped so non-adjacent hits are
 *              visibly separated.
 * - `range`  - an explicit 1-based inclusive line range.
 * - `step`   - one pipeline stage's log, via wfapi when the plugin is there
 *              and a console grep for the stage name when it is not.
 * - `failed` - the window around the failure: the failed stage's last mention,
 *              or the last error marker, or the tail.
 *
 * The whole console text is fetched once and cached under a SINGLE key
 * (`log:console`) rather than per-mode: the extraction is pure in-memory work,
 * so caching raw text both avoids the mode/parameter key-collision problem
 * entirely and lets five different mode calls share one REST round trip.
 */

import fs from "node:fs";
import path from "node:path";
import { buildKey, type JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { JenkinsError, normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";
import { getBuild } from "./build.js";
import { isMultibranchJob, loadJobIndex } from "./jobs.js";

export type LogMode = "tail" | "grep" | "range" | "step" | "failed";

export interface LogArgs {
  job: string;
  ref?: string;
  build?: string | number;
  /** Index depth, needed to answer "is this job multibranch?" for `normalizeRef`. */
  depth: number;
  mode?: LogMode;
  /** tail: trailing lines to return (default 100). */
  lines?: number;
  /** grep: the pattern, treated as a regex. Required for `mode: "grep"`. */
  pattern?: string;
  /**
   * grep: context lines either side of a hit (default 2).
   * failed: context lines either side of the failure anchor (default 60/20).
   */
  context?: number;
  /** grep: stop scanning after this many matches (default `DEFAULT_GREP_MAX_MATCHES`). */
  maxMatches?: number;
  /** range: 1-based inclusive start. */
  from?: number;
  /** range: 1-based inclusive end. */
  to?: number;
  /** step: the pipeline stage name. Required for `mode: "step"`. */
  step?: string;
  /** Strip ANSI escapes and Jenkins timestamp prefixes (default true). */
  clean?: boolean;
  /** Byte offset for a progressive fetch of a running build's log. */
  cursor?: number;
  /** READ-11: write the RAW log under cwd and return a summary instead of the body. */
  saveTo?: string;
}

/** One contiguous window of the log, carrying its ORIGINAL 1-based start line. */
export interface LogSegment {
  startLine: number;
  lines: string[];
}

/** READ-11 write summary - returned INSTEAD of the log body. */
export interface SaveSummary {
  /** Path relative to cwd, so the caller can hand it straight to another tool. */
  savedTo: string;
  bytes: number;
  lines: number;
  /**
   * 1-based line number of the first ANCHORED failure signal in the saved log,
   * or `undefined` when nothing anchored matched (READ-11). Never a guess -
   * see `findFirstFailureLine`.
   */
  firstFailureLine?: number;
}

export interface LogResult {
  job: string;
  ref?: string;
  /** The selector as resolved for the URL - a number, or a permalink alias. */
  selector: string;
  buildNumber?: number;
  building: boolean;
  mode: LogMode;
  /** Lines in the text the window was cut from. */
  totalLines: number;
  segments: LogSegment[];
  /** Lines across all segments. */
  shownLines: number;
  /** grep only: matches found before context was added. */
  matchCount?: number;
  /**
   * grep only: true when the scan stopped at `max_matches` before reaching the
   * end of the log. `matchCount` is then "matches found so far", NOT "matches
   * in this log" - two different facts that must never be conflated.
   */
  scanStoppedEarly?: boolean;
  /** grep only: lines examined before the scan stopped. */
  scannedLines?: number;
  /** grep only: the `max_matches` bound actually applied. */
  maxMatches?: number;
  pattern?: string;
  /** grep only: the context width actually used, so a hint can offer a narrower one. */
  context?: number;
  step?: string;
  /** step only: which route actually produced the text. */
  stepRoute?: "wfapi" | "console-grep";
  /** failed only: the stage wfapi named as failed, when it could be read. */
  failedStage?: string;
  /** Progressive fetch: byte offset to pass as the next `cursor`. */
  nextCursor?: number;
  /** Progressive fetch: Jenkins is still writing to this log. */
  hasMore?: boolean;
  /**
   * True when a `cursor` was used: a byte offset says nothing about how many
   * lines preceded it, so the numbers are relative to the returned chunk.
   */
  chunkRelative?: boolean;
  saved?: SaveSummary;
}

/** Default trailing lines for `tail`. */
const DEFAULT_TAIL_LINES = 100;
/** Default context lines either side of a `grep` hit. */
const DEFAULT_GREP_CONTEXT = 2;
/**
 * Default bound on how many `grep` matches are collected before the scan
 * stops. A pattern that hits 50,000 lines would otherwise build 50,000
 * windows only for the formatter to throw all but 200 away.
 */
export const DEFAULT_GREP_MAX_MATCHES = 200;
/** Context around a `failed` window: failures are preceded by their setup, followed by the trace. */
const FAILED_BEFORE = 60;
const FAILED_AFTER = 20;
/** Context around a stage name when `step` falls back to grepping the console. */
const STEP_FALLBACK_CONTEXT = 20;

/** Markers anchoring the `failed` window when wfapi cannot name the stage. */
const FAILURE_MARKER_RE = /error|fail(?:ed|ure)|exception|BUILD FAILED|exit code [1-9]/i;

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/**
 * CSI/OSC escape sequences. Jenkins emits these whenever a build step writes
 * colour (npm, gradle, pytest all do by default), and they are pure noise in a
 * context window.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC
const ANSI_RE = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** The Timestamper plugin's ISO-8601 line prefix, e.g. `[2026-08-27T10:00:00.000Z] `. */
const TIMESTAMP_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z?\]\s?/;

/** Strips ANSI escapes and a leading Jenkins timestamp from one line. */
export function cleanLogLine(line: string): string {
  return line.replace(ANSI_RE, "").replace(TIMESTAMP_PREFIX_RE, "");
}

/**
 * Splits log text into lines, dropping the single trailing newline Jenkins
 * always sends - otherwise every log reports one phantom blank line at the end
 * and every "of N lines" count is off by one.
 */
export function splitLogLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r?\n$/, "").split("\n");
}

/**
 * Merges hit indices into contiguous segments with `context` lines either
 * side. Overlapping or touching windows are merged, so the formatter's `...`
 * separator only ever appears between genuinely non-adjacent groups.
 */
export function buildSegments(lines: string[], hits: number[], context: number): LogSegment[] {
  const segments: LogSegment[] = [];
  let current: { start: number; end: number } | undefined;

  const flush = () => {
    if (current === undefined) return;
    segments.push({
      startLine: current.start + 1,
      lines: lines.slice(current.start, current.end + 1),
    });
    current = undefined;
  };

  for (const hit of hits) {
    const start = Math.max(0, hit - context);
    const end = Math.min(lines.length - 1, hit + context);
    // `<= end + 1` merges touching windows too: a one-line gap costs more as a
    // "..." separator than as the line itself.
    if (current !== undefined && start <= current.end + 1) {
      current.end = Math.max(current.end, end);
      continue;
    }
    flush();
    current = { start, end };
  }
  flush();

  return segments;
}

/** Wraps a window as the single segment the non-grep modes return. */
function oneSegment(lines: string[], start: number, end: number): LogSegment[] {
  const clamped = Math.max(0, start);
  const slice = lines.slice(clamped, end);
  return slice.length === 0 ? [] : [{ startLine: clamped + 1, lines: slice }];
}

function invalidInput(message: string): JenkinsError {
  return new JenkinsError(message, "jenkins_log", undefined, "invalid_input");
}

// ---------------------------------------------------------------------------
// READ-11: save_to
// ---------------------------------------------------------------------------

/**
 * Turns one address component (a job fullName, a ref, a build selector) into
 * relative path segments.
 *
 * READ-11 specifies `.jenkins-mcp/cli/<job>/<ref>/<build>.log` with the job
 * path as REAL nested directories, so `team-a/svc` is two directories, not
 * `team-a-svc`. A ref arrives either raw (`feature/foo`) or `%2F`-encoded
 * (D-07); it is decoded exactly ONCE so both spellings land in the same
 * place, and a component that decodes to `..`, to an absolute path, or to
 * something empty is REJECTED rather than sanitized - silently rewriting a
 * traversal into a lookalike directory is how a containment check gets
 * quietly bypassed.
 */
function pathSegments(value: string, what: string): string[] {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: use it verbatim rather than failing the
    // save over a `%` that was always meant literally.
  }
  if (path.isAbsolute(decoded) || /^[\\/]/.test(decoded)) {
    throw invalidInput(`save_to: the ${what} '${value}' resolves to an absolute path.`);
  }
  const segments = decoded.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) {
    throw invalidInput(`save_to: the ${what} '${value}' is empty once decoded.`);
  }
  for (const segment of segments) {
    if (segment === "..") {
      throw invalidInput(
        `save_to: the ${what} '${value}' traverses outside the current directory.`,
      );
    }
  }
  return segments;
}

/** The default relative destination: `.jenkins-mcp/cli/<job>/<ref>/<build>.log`. */
export function defaultSavePath(job: string, ref: string | undefined, build: string): string {
  const parts = [".jenkins-mcp", "cli", ...pathSegments(job, "job")];
  if (ref !== undefined && ref !== "") parts.push(...pathSegments(ref, "ref"));
  const buildSegments = pathSegments(build, "build");
  parts.push(`${buildSegments.join("-")}.log`);
  return parts.join("/");
}

/**
 * Anchored failure signals, scanned in log order (READ-11, Phase 6 criterion 5).
 *
 * Deliberately NARROW. The marker-region extractor DIAG-03 deleted used a
 * loose `/error|fail/i` scan, which on a normal build matched a compiler
 * warning, a retried flake or the word "error" inside a dependency name - a
 * confident, wrong answer. Every pattern here is either Jenkins' own
 * end-of-build verdict, its build-step failure line, an `ERROR:`/`FATAL:`
 * prefix AT LINE START (as Jenkins and Maven emit it), or a non-zero exit
 * code. Anything less anchored returns `undefined` instead of a guess.
 */
const ANCHORED_FAILURE_RES = [
  /^Finished:\s+(?:FAILURE|ABORTED|UNSTABLE)\b/,
  /^Build step '.*' (?:changed build result to|marked build as) /,
  /\bBuild step .* failed\b/,
  /^(?:\[ERROR\]|ERROR:|FATAL:)/,
  /^BUILD FAILED\b/,
  /\bexit code (?!0\b)[0-9]+/,
  /\bexit status (?!0\b)[0-9]+/,
];

/**
 * The 1-based line number of the first anchored failure signal, or
 * `undefined` when none matched. Computed from the raw text already in
 * memory - never a second fetch.
 */
export function findFirstFailureLine(raw: string): number | undefined {
  const lines = splitLogLines(raw);
  for (let i = 0; i < lines.length; i++) {
    const line = cleanLogLine(lines[i] ?? "");
    for (const re of ANCHORED_FAILURE_RES) {
      if (re.test(line)) return i + 1;
    }
  }
  return undefined;
}

/**
 * Writes the RAW log under cwd and returns a summary (READ-11).
 *
 * The containment check is three-part, because each part is defeated on its
 * own. `path.resolve` is defeated by a symlinked directory (`out` may resolve
 * to `<cwd>/out` and still be a link to `/etc`), so the nearest EXISTING
 * ancestor is additionally resolved with `realpathSync`. That walk-up uses
 * `lstat`, not `existsSync`: `existsSync` FOLLOWS symlinks, so a pre-existing
 * DANGLING link in cwd reads as absent and the walk skips past the very thing
 * it is meant to catch. And the write itself goes through `O_NOFOLLOW`, which
 * closes the check-then-write race on the final component and rejects a link
 * planted between the two.
 *
 * This is the only filesystem side effect in `@jenkins-mcp/core`, kept in one
 * exported function so it is testable without a Jenkins round trip.
 */
export function saveRawLog(saveTo: string, fallbackPath: string, raw: string): SaveSummary {
  const requested = saveTo.trim() === "" || saveTo.trim() === "true" ? fallbackPath : saveTo.trim();

  if (path.isAbsolute(requested)) {
    throw invalidInput(
      `save_to must be a relative path under the current directory; '${requested}' is absolute.`,
    );
  }
  if (requested.split(/[/\\]/).includes("..")) {
    throw invalidInput(`save_to must not traverse outside the current directory: '${requested}'.`);
  }

  const realCwd = fs.realpathSync(process.cwd());
  const target = path.resolve(realCwd, requested);
  if (target !== realCwd && !target.startsWith(realCwd + path.sep)) {
    throw invalidInput(`save_to resolves outside the current directory: '${requested}'.`);
  }

  // Walk up to the nearest path that EXISTS AS A LINK OR FILE, then resolve
  // symlinks on it. `lstatSync` rather than `existsSync` - see the doc comment.
  let existing = target;
  while (
    fs.lstatSync(existing, { throwIfNoEntry: false }) === undefined &&
    path.dirname(existing) !== existing
  ) {
    existing = path.dirname(existing);
  }
  if (fs.lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw invalidInput(
      `save_to must not be or pass through a symlink: '${requested}' is a symbolic link.`,
    );
  }
  const realExisting = fs.realpathSync(existing);
  if (realExisting !== realCwd && !realExisting.startsWith(realCwd + path.sep)) {
    throw invalidInput(
      `save_to resolves outside the current directory through a symlink: '${requested}'.`,
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeContained(target, requested, raw);

  return {
    savedTo: path.relative(realCwd, target),
    bytes: Buffer.byteLength(raw, "utf8"),
    lines: splitLogLines(raw).length,
    firstFailureLine: findFirstFailureLine(raw),
  };
}

/**
 * Opens the target with `O_NOFOLLOW` and truncates only after the file is
 * proven to be an ordinary, single-linked file.
 *
 * A hardlink is invisible to every path-based check - `realpathSync` of a
 * hardlink in cwd returns the in-cwd path - so the link count is the only
 * signal that the inode is shared with a file elsewhere. Checking it before
 * `ftruncate` matters: truncating first would already have destroyed the
 * outside file by the time the check ran.
 */
function writeContained(target: string, requested: string, raw: string): void {
  const { O_WRONLY, O_CREAT, O_NOFOLLOW } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(target, O_WRONLY | O_CREAT | O_NOFOLLOW, 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw invalidInput(
        `save_to must not be or pass through a symlink: '${requested}' is a symbolic link.`,
      );
    }
    throw err;
  }

  try {
    if (fs.fstatSync(fd).nlink > 1) {
      throw invalidInput(
        `save_to is a hard link to a file outside the current directory: '${requested}'.`,
      );
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, raw, 0, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** wfapi's per-node log response. `text` carries the stage output. */
interface WfapiNodeLog {
  text?: string;
}

interface WfapiStageEntry {
  id?: string;
  name?: string;
  status?: string;
}

interface WfapiDescribeResponse {
  stages?: WfapiStageEntry[];
}

async function fetchText(client: JenkinsClient, url: string, label: string): Promise<string> {
  const res = await client.get(url);
  if (!res.ok) throw normalizeError(res, label);
  return res.text();
}

/** One progressive-log chunk: the bytes written since a cursor. */
export interface ProgressiveChunk {
  /** Raw text written since the requested offset. */
  text: string;
  /**
   * Byte offset to pass as the next cursor, from `X-Text-Size`. Left
   * undefined when the header is absent or unparseable - echoing the caller's
   * own cursor back would have it poll the same offset forever.
   */
  nextCursor?: number;
  /** `X-More-Data`: Jenkins is still writing to this log. */
  hasMore: boolean;
}

/**
 * Reads `logText/progressiveText?start=<cursor>` - the ONE progressive-log
 * reader in this package. `jenkins_log`'s cursor mode and `waitForBuild`'s
 * "new log lines since the byte cursor" both call it, so the two can never
 * disagree about what a cursor means.
 *
 * Jenkins answers with the bytes from that offset plus two headers:
 * `X-Text-Size` (the offset to pass next) and `X-More-Data` ("true" while the
 * build is still writing). UNVERIFIED against a live instance - the header
 * names come from the Jenkins docs, not from an observed response.
 */
export async function readProgressiveText(
  client: JenkinsClient,
  base: string,
  cursor: number,
  label = "jenkins_log",
): Promise<ProgressiveChunk> {
  const res = await client.get(`${base}/logText/progressiveText?start=${cursor}`);
  if (!res.ok) throw normalizeError(res, label);
  const text = await res.text();
  const textSize = Number.parseInt(res.headers.get("X-Text-Size") ?? "", 10);
  return {
    text,
    nextCursor: Number.isFinite(textSize) ? textSize : undefined,
    hasMore: res.headers.get("X-More-Data") === "true",
  };
}

/**
 * Reads `/wfapi/describe`, or `undefined` when this Jenkins has no Pipeline
 * REST API plugin (or the job is freestyle) - both surface as a non-ok
 * response, and both mean "fall back to the console".
 *
 * Cached under the build's own key, including the negative answer: `step` and
 * `failed` both ask, and on a freestyle build every ask is a guaranteed 404.
 * Ideally this would be skipped entirely for a build whose `_class` is not a
 * pipeline run, the way `build-detail` does it, but `getBuild` does not carry
 * `_class`, so caching the 404 is what is available here.
 */
async function describeStages(
  client: JenkinsClient,
  cache: JenkinsCache,
  key: { job: string; ref?: string; selector: string; tier: "permanent" | "volatile" },
  base: string,
): Promise<WfapiStageEntry[] | undefined> {
  return cache.fetch(
    buildKey(key.job, key.ref, key.selector, "log:wfapi"),
    async () => {
      const res = await client.get(`${base}/wfapi/describe`);
      if (!res.ok) return undefined;
      try {
        return ((await res.json()) as WfapiDescribeResponse).stages ?? [];
      } catch {
        return undefined;
      }
    },
    key.tier,
  );
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Reads a window of one build's console log (READ-10/READ-11).
 *
 * Cache tier follows the build, not the request: a numbered build that has
 * finished can never emit another byte, so its console text is cached for the
 * life of the process; a running build gets the 10s volatile tier; and a
 * progressive `cursor` fetch is never cached at all, since its whole purpose
 * is to return whatever arrived since the last call.
 */
export async function getBuildLog(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: LogArgs,
): Promise<LogResult> {
  // Resolved before any request, so a bad selector is an `invalid_input` error
  // rather than an index round trip whose own failure would mask it.
  const selector = resolveBuildSelector(args.build);

  // A `cursor` fetch returns whatever bytes arrived since an offset. It cannot
  // honour a line-based mode (the chunk is not the log) and it must not write
  // itself over the canonical full-log file, so both are refused outright
  // rather than answered with something that contradicts its own header.
  if (args.cursor !== undefined && args.mode !== undefined && args.mode !== "tail") {
    throw invalidInput(
      `cursor returns the raw bytes written since an offset, so it cannot be combined with ` +
        `mode=${args.mode}. Read without cursor for that mode, or poll with cursor alone.`,
    );
  }
  if (args.cursor !== undefined && args.saveTo !== undefined) {
    throw invalidInput(
      "cursor cannot be combined with save_to: it would write only the latest chunk over the " +
        "full log's file. Save without cursor, or poll without save_to.",
    );
  }
  if (args.lines !== undefined && (!Number.isInteger(args.lines) || args.lines < 1)) {
    throw invalidInput(`lines must be a whole number of 1 or more; got ${args.lines}.`);
  }
  if (args.context !== undefined && (!Number.isInteger(args.context) || args.context < 0)) {
    throw invalidInput(`context must be a whole number of 0 or more; got ${args.context}.`);
  }

  const index = await loadJobIndex(client, cache, args.depth);
  const ref = normalizeRef(args.ref, isMultibranchJob(index, args.job));
  const base = `${jobRestPath(args.job, ref)}/${selector}`;

  const summary = await getBuild(client, cache, { job: args.job, ref, build: args.build });
  const clean = args.clean !== false;
  const mode: LogMode = args.mode ?? "tail";

  const head = {
    job: args.job,
    ref,
    selector,
    buildNumber: summary.number,
    building: summary.building,
    mode,
  };

  // Progressive fetch. Jenkins answers a `logText/progressiveText?start=<n>`
  // GET with the bytes from that offset plus two headers: `X-Text-Size` (the
  // offset to pass next) and `X-More-Data` ("true" while the build is still
  // writing). UNVERIFIED against a live instance - header names come from the
  // Jenkins docs, not from an observed response.
  if (args.cursor !== undefined) {
    const progressive = await readProgressiveText(client, base, args.cursor);
    const chunk = splitLogLines(progressive.text).map((line) =>
      clean ? cleanLogLine(line) : line,
    );

    return {
      ...head,
      totalLines: chunk.length,
      segments: chunk.length === 0 ? [] : [{ startLine: 1, lines: chunk }],
      shownLines: chunk.length,
      chunkRelative: true,
      nextCursor: progressive.nextCursor,
      hasMore: progressive.hasMore,
    };
  }

  const cacheable = /^\d+$/.test(selector) && !summary.building;
  const tier = cacheable ? "permanent" : "volatile";

  // `step` reads only that stage's log; every other mode works from the whole
  // console text, which is fetched once and shared across modes via one key.
  if (mode === "step") {
    return stepResult(client, cache, args, { base, head, tier, clean });
  }

  const rawConsole = await cache.fetch(
    buildKey(args.job, ref, selector, "log:console"),
    () => fetchText(client, `${base}/consoleText`, "jenkins_log"),
    tier,
  );

  if (args.saveTo !== undefined) {
    const saved = saveChunk(args, rawConsole, head, selector);
    const all = splitLogLines(rawConsole);
    return { ...head, totalLines: all.length, segments: [], shownLines: 0, saved };
  }

  const rawLines = splitLogLines(rawConsole);
  const lines = clean ? rawLines.map(cleanLogLine) : rawLines;
  const total = lines.length;

  // A running build's first read hands back the byte offset it read up to, so
  // progressive polling has a documented entry point instead of a guessed
  // `cursor=0`. Only meaningful while the build is still writing.
  const firstCursor = summary.building ? Buffer.byteLength(rawConsole, "utf8") : undefined;

  switch (mode) {
    case "grep":
      return { ...head, ...grepWindow(lines, args), totalLines: total, nextCursor: firstCursor };
    case "range":
      return { ...head, ...rangeWindow(lines, args), totalLines: total, nextCursor: firstCursor };
    case "failed":
      return {
        ...head,
        ...(await failedWindow(
          client,
          cache,
          { ...head, selector, tier },
          base,
          lines,
          args.context,
        )),
        totalLines: total,
        nextCursor: firstCursor,
      };
    default: {
      const want = args.lines ?? DEFAULT_TAIL_LINES;
      const segments = oneSegment(lines, total - want, total);
      return {
        ...head,
        totalLines: total,
        segments,
        shownLines: countLines(segments),
        nextCursor: firstCursor,
      };
    }
  }
}

function countLines(segments: LogSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.lines.length, 0);
}

function saveChunk(
  args: LogArgs,
  raw: string,
  head: { job: string; ref?: string; buildNumber?: number },
  selector: string,
): SaveSummary {
  const build = head.buildNumber === undefined ? selector : String(head.buildNumber);
  return saveRawLog(args.saveTo ?? "", defaultSavePath(head.job, head.ref, build), raw);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function grepWindow(
  lines: string[],
  args: LogArgs,
): Pick<
  LogResult,
  | "segments"
  | "shownLines"
  | "matchCount"
  | "scanStoppedEarly"
  | "scannedLines"
  | "maxMatches"
  | "pattern"
  | "context"
> {
  const pattern = args.pattern;
  if (pattern === undefined || pattern === "") {
    throw invalidInput("mode=grep needs a pattern. Pass pattern with a regular expression.");
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // The thrown SyntaxError's own message is not interpolated - it echoes the
    // pattern back with engine internals, and an agent only needs the code.
    throw invalidInput(`pattern is not a valid regular expression: '${pattern}'.`);
  }

  const maxMatches = args.maxMatches ?? DEFAULT_GREP_MAX_MATCHES;
  if (!Number.isInteger(maxMatches) || maxMatches < 1) {
    throw invalidInput(`max_matches must be a whole number of 1 or more; got ${args.maxMatches}.`);
  }

  // Early stop (Phase 6 criterion 4). `scannedLines` is what makes the two
  // facts distinguishable: "the log has N matches" and "we stopped looking
  // after N" are different answers, and reporting the second as the first is
  // exactly the confident-but-wrong shape this codebase keeps closing off.
  const hits: number[] = [];
  let scannedLines = 0;
  for (let i = 0; i < lines.length; i++) {
    scannedLines = i + 1;
    if (re.test(lines[i] ?? "")) hits.push(i);
    if (hits.length >= maxMatches) break;
  }
  const scanStoppedEarly = hits.length >= maxMatches && scannedLines < lines.length;

  const context = args.context ?? DEFAULT_GREP_CONTEXT;
  const segments = buildSegments(lines, hits, context);
  return {
    segments,
    shownLines: countLines(segments),
    matchCount: hits.length,
    scanStoppedEarly,
    scannedLines,
    maxMatches,
    pattern,
    context,
  };
}

function rangeWindow(lines: string[], args: LogArgs): Pick<LogResult, "segments" | "shownLines"> {
  const total = lines.length;
  const rawFrom = args.from ?? 1;
  const rawTo = args.to ?? total;

  if (!Number.isInteger(rawFrom)) {
    throw invalidInput(`from must be a whole line number; got ${rawFrom}.`);
  }
  if (!Number.isInteger(rawTo)) {
    throw invalidInput(`to must be a whole line number; got ${rawTo}.`);
  }
  if (rawFrom === 0 || rawTo === 0) {
    throw invalidInput("line numbers are 1-based; 0 addresses no line. Use 1, or -1 for the last.");
  }

  // Negative = end-relative (Phase 6 criterion 4): -1 is the last line, so
  // `from: -100, to: -1` is the last 100 lines. Resolved BEFORE the ordering
  // check, so an inverted range is still rejected once both ends are known.
  const from = rawFrom < 0 ? Math.max(1, total + rawFrom + 1) : rawFrom;
  const to = rawTo < 0 ? total + rawTo + 1 : rawTo;

  if (to < from) {
    throw invalidInput(
      `from (${rawFrom} = line ${from}) must not be greater than to (${rawTo} = line ${to}).`,
    );
  }
  if (to < 1) {
    throw invalidInput(`to (${rawTo}) is before the start of the log, which has ${total} lines.`);
  }
  if (from > total) {
    throw invalidInput(`from (${rawFrom}) is past the end of the log, which has ${total} lines.`);
  }

  // `to` past the end is clamped rather than rejected: asking for the last 200
  // lines by number is a normal thing to do without knowing the exact count.
  const segments = oneSegment(lines, from - 1, Math.min(to, total));
  return { segments, shownLines: countLines(segments) };
}

/**
 * The window around the failure.
 *
 * wfapi names the failed stage when the plugin is present, which anchors the
 * window far more precisely than a marker scan; without it, the last error
 * marker is used, and without that, the tail. Never returns nothing for a
 * non-empty log.
 */
async function failedWindow(
  client: JenkinsClient,
  cache: JenkinsCache,
  key: { job: string; ref?: string; selector: string; tier: "permanent" | "volatile" },
  base: string,
  lines: string[],
  context: number | undefined,
): Promise<Pick<LogResult, "segments" | "shownLines" | "failedStage">> {
  const stages = await describeStages(client, cache, key, base);
  const failedStage = stages?.find((stage) => stage.status === "FAILED")?.name;

  let anchor = -1;
  if (failedStage !== undefined) {
    anchor = lastIndexMatching(lines, (line) => line.includes(failedStage));
  }
  if (anchor === -1) {
    anchor = lastIndexMatching(lines, (line) => FAILURE_MARKER_RE.test(line));
  }

  // A caller-supplied `context` sets BOTH sides symmetrically; with none, the
  // asymmetric default stands (a failure is preceded by its setup and followed
  // by its stack trace, which are not the same length).
  const before = context ?? FAILED_BEFORE;
  const after = context ?? FAILED_AFTER;

  const segments =
    anchor === -1
      ? oneSegment(lines, lines.length - (context ?? DEFAULT_TAIL_LINES), lines.length)
      : oneSegment(lines, anchor - before, Math.min(lines.length, anchor + after + 1));

  return { segments, shownLines: countLines(segments), failedStage };
}

function lastIndexMatching(lines: string[], predicate: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (predicate(lines[i] ?? "")) return i;
  }
  return -1;
}

/**
 * One pipeline stage's log.
 *
 * The pipeline route is `wfapi/describe` to find the stage id, then
 * `execution/node/<id>/wfapi/log`, which answers with JSON carrying the stage
 * output under `text`. UNVERIFIED against a live instance. When either request
 * fails - freestyle job, plugin absent, stage renamed - this falls back to
 * grepping the whole console for the stage name, and the result says which
 * route produced the text so the caller is never misled about precision.
 */
async function stepResult(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: LogArgs,
  ctx: {
    base: string;
    head: Pick<LogResult, "job" | "ref" | "selector" | "buildNumber" | "building" | "mode">;
    tier: "permanent" | "volatile";
    clean: boolean;
  },
): Promise<LogResult> {
  const step = args.step;
  if (step === undefined || step === "") {
    throw invalidInput("mode=step needs a step. Pass step with the pipeline stage name.");
  }

  const stages = await describeStages(
    client,
    cache,
    { job: args.job, ref: ctx.head.ref, selector: ctx.head.selector, tier: ctx.tier },
    ctx.base,
  );
  const match = stages?.find((stage) => stage.name?.toLowerCase() === step.toLowerCase());

  if (match?.id !== undefined) {
    const body = await cache.fetch(
      buildKey(args.job, ctx.head.ref, ctx.head.selector, `log:step:${match.id}`),
      () =>
        fetchText(
          client,
          `${ctx.base}/execution/node/${encodeURIComponent(match.id ?? "")}/wfapi/log`,
          "jenkins_log",
        ),
      ctx.tier,
    );
    const text = readWfapiNodeLog(body).text;
    const raw = splitLogLines(text);
    const lines = ctx.clean ? raw.map(cleanLogLine) : raw;

    if (args.saveTo !== undefined) {
      const saved = saveChunk(args, text, ctx.head, ctx.head.selector);
      return {
        ...ctx.head,
        step,
        stepRoute: "wfapi",
        totalLines: lines.length,
        segments: [],
        shownLines: 0,
        saved,
      };
    }

    return {
      ...ctx.head,
      step,
      stepRoute: "wfapi",
      totalLines: lines.length,
      segments: lines.length === 0 ? [] : [{ startLine: 1, lines }],
      shownLines: lines.length,
    };
  }

  // Fallback: grep the whole console for the stage name.
  const rawConsole = await cache.fetch(
    buildKey(args.job, ctx.head.ref, ctx.head.selector, "log:console"),
    () => fetchText(client, `${ctx.base}/consoleText`, "jenkins_log"),
    ctx.tier,
  );

  if (args.saveTo !== undefined) {
    const saved = saveChunk(args, rawConsole, ctx.head, ctx.head.selector);
    return {
      ...ctx.head,
      step,
      stepRoute: "console-grep",
      totalLines: splitLogLines(rawConsole).length,
      segments: [],
      shownLines: 0,
      saved,
    };
  }

  const raw = splitLogLines(rawConsole);
  const lines = ctx.clean ? raw.map(cleanLogLine) : raw;
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").includes(step)) hits.push(i);
  }
  const segments = buildSegments(lines, hits, args.context ?? STEP_FALLBACK_CONTEXT);

  return {
    ...ctx.head,
    step,
    stepRoute: "console-grep",
    totalLines: lines.length,
    segments,
    shownLines: countLines(segments),
    matchCount: hits.length,
  };
}

/** Which body shape a wfapi node-log response actually turned out to be. */
export type WfapiLogShape = "json" | "text";

export interface WfapiNodeLogText {
  text: string;
  /** What was actually parsed - `json` means the `{ text: ... }` envelope. */
  shape: WfapiLogShape;
}

/**
 * The ONE reader for a wfapi node-log body (`execution/node/<id>/wfapi/log`),
 * shared by `jenkins_log`'s step mode and `jenkins_diagnose_build`.
 *
 * The two used to disagree: this module unwrapped a `{ text: ... }` JSON
 * envelope, `operations/diagnose.ts` read the same endpoint as plain text. At
 * most one of those could be right, and neither is verifiable without a live
 * instance - so both now call this, which handles BOTH shapes and reports
 * which one it saw. It NEVER throws: an unparseable body degrades to itself
 * as text, because a diagnosis that fails over a response shape is worse than
 * one that hands back the raw body.
 */
export function readWfapiNodeLog(body: string): WfapiNodeLogText {
  if (!body.trimStart().startsWith("{")) return { text: body, shape: "text" };
  try {
    const parsed = JSON.parse(body) as WfapiNodeLog;
    // A JSON object without `text` is still the envelope shape, just empty -
    // returning the raw JSON as "log output" would be worse than nothing.
    return typeof parsed.text === "string"
      ? { text: parsed.text, shape: "json" }
      : { text: "", shape: "json" };
  } catch {
    return { text: body, shape: "text" };
  }
}

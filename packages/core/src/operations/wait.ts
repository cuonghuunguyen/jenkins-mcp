/**
 * Blocking build watch (CTRL-06, Phase 7 criterion 1).
 *
 * Polls one build until it stops building, a stage pauses on an `input` step,
 * a bound elapses, or the caller's signal aborts. It is the one operation an
 * agent is expected to sit inside, so four properties matter more than
 * anything it returns:
 *
 * 1. It ALWAYS returns. A timeout is information ("still running after 2m"),
 *    not an error - an agent that gets a throw here learns nothing about the
 *    build, and a `finished: false` result it can render and re-issue is
 *    strictly more useful. That extends to a transient non-ok poll AFTER the
 *    wait has already seen the build: one 503 from a restarting controller
 *    must not discard forty successful polls' worth of knowledge.
 * 2. It never caches the poll. This is the one place where the process-wide
 *    cache (AGNT-01) is actively wrong: a cached `building: true` would be
 *    replayed for the whole tier lifetime and the loop would never terminate.
 *    This BUILD's cache IS invalidated once it finishes, so the next
 *    `{build}` read sees the final result instead of a stale running one.
 * 3. It detects a pipeline paused on `input`. Such a build never finishes on
 *    its own, so a wait that cannot see it burns the full timeout and then
 *    reports "still running" - true, and useless. `wfapi/describe` is what
 *    makes that state observable at all, which is why it is the primary poll.
 * 4. Its bound cannot be defeated by a non-number. `NaN` is the one value
 *    that removes the loop's only elapsed-time exit (every comparison against
 *    it is false), and the CLI's `--timeout abc` produces exactly that, so
 *    the guard lives HERE where every caller routes through rather than at
 *    one call site.
 *
 * Each poll's `client.get` is bounded by the client's own request timeout, so
 * a wedged instance cannot stall an iteration; no second timeout mechanism is
 * layered on top of it.
 */

import type { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";
import { isMultibranchJob, loadJobIndex } from "./jobs.js";
import { cleanLogLine, readProgressiveText, splitLogLines } from "./log.js";

/** `tree=` projection for one `api/json` poll - the smallest shape that answers "done yet?". */
export const WAIT_TREE_FIELDS = "number,result,building,duration,timestamp,url";

/**
 * Default bound on the whole wait, matching the MCP surface's documented
 * `timeout_s = 120`. The CLI passes `Infinity` for an unbounded `jenkins
 * build wait`, which is the documented difference between the two surfaces:
 * a human at a shell can Ctrl-C, an agent cannot.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

/** First delay between polls. */
const INITIAL_POLL_MS = 2_000;
/** Backoff multiplier applied after each poll, as in `pollQueueItem`. */
const BACKOFF_MULTIPLIER = 1.5;
/** Backoff ceiling: past this the wait stops feeling responsive. */
const MAX_POLL_MS = 15_000;

/**
 * Consecutive non-ok polls tolerated once the wait has already read the build
 * at least once. Past this the wait gives up and REPORTS the failure as a
 * result rather than throwing away everything it learned.
 */
export const MAX_TRANSIENT_POLL_ERRORS = 3;

/**
 * wfapi status meaning "a stage is blocked on an `input` step waiting for a
 * human". UNVERIFIED against a live instance - the value comes from the
 * Pipeline Stage View API's documented status enum, not from an observed
 * response, so the check is a set rather than an equality and any status that
 * merely *contains* PAUSED is treated the same way.
 */
const PAUSED_STATUSES = new Set(["PAUSED_PENDING_INPUT", "PAUSED"]);

/** wfapi statuses that mean the run has not reached a terminal state. */
const RUNNING_STATUSES = new Set(["IN_PROGRESS", "NOT_EXECUTED", "QUEUED"]);

function isPaused(status: string | undefined): boolean {
  if (status === undefined) return false;
  return PAUSED_STATUSES.has(status) || status.includes("PAUSED");
}

interface ApiBuildState {
  number?: number;
  result?: string | null;
  building?: boolean;
  duration?: number;
  timestamp?: number;
  url?: string;
}

/** One `stages[]` entry of a `/wfapi/describe` response. */
interface WfapiStageEntry {
  id?: string;
  name?: string;
  status?: string;
  durationMillis?: number;
}

/** The `/wfapi/describe` shape this operation reads. */
interface WfapiDescribe {
  id?: string;
  status?: string;
  durationMillis?: number;
  startTimeMillis?: number;
  stages?: WfapiStageEntry[];
}

/** One stage as reported to the caller. */
export interface StageTransition {
  id: string;
  name: string;
  status: string;
  durationMs?: number;
}

export interface WaitArgs {
  job: string;
  ref?: string;
  /** Build number, -1, or a permalink alias. Defaults to lastBuild. */
  build?: string | number;
  /**
   * Index depth, used only to decide whether a bare-integer `ref` means a PR
   * (REF-01). Omit when the ref is already resolved - `triggerBuild` chains a
   * wait with the very ref it POSTed to, and re-resolving it there could
   * address a different job than the one that was just triggered.
   */
  depth?: number;
  /**
   * Bound on the whole wait. Defaults to `DEFAULT_WAIT_TIMEOUT_MS`; pass
   * `Number.POSITIVE_INFINITY` for an unbounded wait (then only the build
   * finishing, an `input` step or the abort signal ends it). A non-number is
   * replaced by the default rather than silently removing the bound.
   */
  timeoutMs?: number;
  /** First poll delay; backs off from here. */
  pollIntervalMs?: number;
  /**
   * Stage id the caller was last told about. Stage transitions are reported
   * from that stage onward, so a follow-up wait does not repeat the whole
   * pipeline.
   */
  sinceCursor?: string;
  /** Byte offset into the console log; new lines since it are returned. */
  logCursor?: number;
  /** Strip ANSI escapes and Jenkins timestamp prefixes from new log lines. */
  clean?: boolean;
  signal?: AbortSignal;
}

export interface WaitResult {
  job: string;
  ref?: string;
  /** The selector as resolved for the URL - a number, or a permalink alias. */
  selector: string;
  number?: number;
  /** True when the build reached a terminal state inside the bound. */
  finished: boolean;
  /** Why an unfinished wait ended. Absent when `finished` is true. */
  stopped?: "timeout" | "aborted" | "input" | "error";
  result: string | null;
  building: boolean;
  durationMs?: number;
  timestamp?: number;
  url?: string;
  /** Wall-clock time spent waiting. */
  waitedMs: number;
  /** Polls issued - the REST-request count this wait cost. */
  polls: number;
  /**
   * Stage transitions since `sinceCursor`, newest last. `undefined` means no
   * stage data was available at all (freestyle build, or no Pipeline REST API
   * plugin) - distinct from `[]`, "a pipeline that has started no stage yet".
   */
  stages?: StageTransition[];
  /** Stage id to pass as the next `since_cursor`. */
  nextCursor?: string;
  /** Set when `stopped === "input"`: the stage a human has to answer. */
  inputStage?: string;
  /** New log lines since `logCursor`, when one was given. */
  newLines?: string[];
  /** Byte offset to pass as the next `log_cursor`. */
  nextLogCursor?: number;
  /** True when `wfapi/describe` was unavailable and `api/json` was polled instead. */
  wfapiUnavailable?: boolean;
  /** Non-ok polls that were tolerated rather than thrown. */
  transientErrors?: number;
  /** Set when `stopped === "error"`: the error code the last poll produced. */
  lastErrorCode?: string;
}

/**
 * Replaces a non-number bound with the default.
 *
 * `NaN` removes a `Date.now() - start >= timeoutMs` loop's only elapsed-time
 * exit, because every comparison against NaN is false. yargs' `type: "number"`
 * produces NaN for `--timeout abc`, so this guard belongs in core, where all
 * four call sites (two waits, two queue polls) route through it. `Infinity` is
 * deliberately allowed: that is how an unbounded CLI wait is expressed.
 */
export function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs)) return fallback;
  return timeoutMs;
}

/**
 * Sleeps, but wakes immediately if `signal` aborts. An abort that only takes
 * effect after a full 15s backoff would make a cancelled wait feel hung.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // An ALREADY-aborted signal never dispatches another `abort` event, so
  // listening alone would wait out the full backoff on a cancelled wait.
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Stage transitions the caller has not been told about.
 *
 * The cursor names the LAST stage the caller saw. Reporting from that stage
 * INCLUSIVE is deliberate: its status may have moved on since (IN_PROGRESS ->
 * SUCCESS is a transition, and nothing in the response records what its
 * status was when the caller last looked). One repeated row costs a line; a
 * dropped transition costs the caller the thing it asked for.
 */
export function transitionsSince(
  stages: StageTransition[],
  sinceCursor: string | undefined,
): StageTransition[] {
  if (sinceCursor === undefined) return stages;
  const at = stages.findIndex((stage) => stage.id === sinceCursor);
  // An unknown cursor means it came from a different build (or the stage list
  // was rebuilt). Reporting everything is the honest answer; silently
  // returning nothing would read as "no progress".
  return at === -1 ? stages : stages.slice(at);
}

function toStages(body: WfapiDescribe): StageTransition[] {
  return (body.stages ?? []).map((stage, index) => ({
    id: stage.id ?? String(index),
    name: stage.name ?? stage.id ?? "?",
    status: stage.status ?? "UNKNOWN",
    durationMs: stage.durationMillis,
  }));
}

/**
 * Blocks until the build finishes, a stage pauses on `input`, the bound
 * elapses, or the signal aborts.
 *
 * `wfapi/describe` is the primary poll (Phase 7 criterion 1): it is the only
 * endpoint that reports stage transitions and a pending `input` step. A
 * freestyle build and an instance without the Pipeline REST API plugin both
 * answer it with a 404, which switches the loop to `api/json` for the rest of
 * the wait - the same degradation `build-detail.ts` and `diagnose.ts` use.
 *
 * The exponential backoff (2s -> 15s) keeps a long build cheap: a 30-minute
 * build costs ~2 minutes' worth of polls, not 900 of them.
 */
export async function waitForBuild(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: WaitArgs,
): Promise<WaitResult> {
  const selector = resolveBuildSelector(args.build);

  // The index is only consulted when the ref could be a PR number; every
  // other ref is already the child job's name.
  const ref =
    args.depth !== undefined && /^\d+$/.test(String(args.ref ?? ""))
      ? normalizeRef(
          args.ref,
          isMultibranchJob(await loadJobIndex(client, cache, args.depth), args.job),
        )
      : args.ref;

  const base = `${jobRestPath(args.job, ref)}/${selector}`;
  const apiPath = `${base}/api/json?tree=${WAIT_TREE_FIELDS}`;
  const timeoutMs = resolveTimeoutMs(args.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const start = Date.now();

  let delayMs = args.pollIntervalMs ?? INITIAL_POLL_MS;
  let polls = 0;
  let last: ApiBuildState = {};
  let stages: StageTransition[] | undefined;
  let inputStage: string | undefined;
  let useWfapi = true;
  let wfapiUnavailable = false;
  let transientErrors = 0;
  let consecutiveErrors = 0;
  let lastErrorCode: string | undefined;

  /** Fills in the fields only `api/json` carries, after a wfapi-driven wait. */
  const fillFromApi = async (): Promise<void> => {
    // Nothing was read from wfapi, so there is nothing to fill IN - and a
    // wait cancelled before its first poll must not cost a request either.
    if (!useWfapi || polls === 0) return;
    try {
      const res = await client.get(apiPath);
      if (!res.ok) return;
      const body = (await res.json()) as ApiBuildState;
      last = { ...last, ...body };
    } catch {
      // A failed enrichment must never fail the wait; the wfapi-derived
      // status stands on its own.
    }
  };

  /** Reads whatever was written to the console since the caller's byte cursor. */
  const readNewLines = async (): Promise<Pick<WaitResult, "newLines" | "nextLogCursor">> => {
    if (args.logCursor === undefined) return {};
    try {
      const chunk = await readProgressiveText(client, base, args.logCursor, "jenkins_wait_build");
      const raw = splitLogLines(chunk.text);
      return {
        newLines: args.clean === false ? raw : raw.map(cleanLogLine),
        nextLogCursor: chunk.nextCursor,
      };
    } catch {
      // Same rule as the api/json fill-in: the log is an enrichment, not the
      // answer. Losing it must not turn a completed wait into an error.
      return {};
    }
  };

  const snapshot = async (
    finished: boolean,
    stopped?: WaitResult["stopped"],
  ): Promise<WaitResult> => {
    await fillFromApi();
    const log = await readNewLines();
    const reported = stages === undefined ? undefined : transitionsSince(stages, args.sinceCursor);
    return {
      job: args.job,
      ref,
      selector,
      number: last.number,
      finished,
      stopped,
      result: last.result ?? null,
      building: last.building === true,
      durationMs: last.duration,
      timestamp: last.timestamp,
      url: last.url,
      waitedMs: Date.now() - start,
      polls,
      stages: reported,
      nextCursor: stages?.[stages.length - 1]?.id,
      inputStage,
      wfapiUnavailable: wfapiUnavailable ? true : undefined,
      transientErrors: transientErrors > 0 ? transientErrors : undefined,
      lastErrorCode,
      ...log,
    };
  };

  for (;;) {
    // Checked BEFORE the request, not only after it: an already-aborted signal
    // used to still cost a full round trip (up to the client's 60s timeout).
    if (args.signal?.aborted === true) return snapshot(false, "aborted");

    const res = await client.get(useWfapi ? `${base}/wfapi/describe` : apiPath);

    if (useWfapi && res.status === 404) {
      // No Pipeline REST API plugin, or a freestyle build. Neither is an
      // error; both mean "poll api/json for the rest of this wait".
      useWfapi = false;
      wfapiUnavailable = true;
      continue;
    }

    if (!res.ok) {
      // Nothing has been read yet, so there is no partial answer worth
      // returning - the caller is better served by the real error.
      if (polls === 0) throw normalizeError(res, "jenkins_wait_build");

      transientErrors += 1;
      consecutiveErrors += 1;
      lastErrorCode = normalizeError(res, "jenkins_wait_build").code;
      if (consecutiveErrors > MAX_TRANSIENT_POLL_ERRORS) return snapshot(false, "error");

      await sleep(delayMs, args.signal);
      delayMs = Math.min(delayMs * BACKOFF_MULTIPLIER, MAX_POLL_MS);
      continue;
    }

    consecutiveErrors = 0;
    lastErrorCode = undefined;
    polls += 1;

    if (useWfapi) {
      const body = (await res.json().catch(() => ({}))) as WfapiDescribe;
      const buildStatus = body.status;

      // A 200 that carries no `status` is not a describe response this code
      // can steer on - some proxies answer an unknown path with an HTML or
      // empty 200 rather than a 404. Treating it as "still running" would poll
      // to the timeout on a build that finished long ago, so it degrades to
      // api/json exactly like a 404 does.
      if (buildStatus === undefined) {
        useWfapi = false;
        wfapiUnavailable = true;
        polls -= 1;
        continue;
      }

      stages = toStages(body);
      const paused = stages.find((stage) => isPaused(stage.status));

      last = {
        ...last,
        number: body.id === undefined ? last.number : Number.parseInt(body.id, 10) || last.number,
        duration: body.durationMillis,
        timestamp: body.startTimeMillis,
        building: RUNNING_STATUSES.has(buildStatus ?? "") || isPaused(buildStatus),
        result:
          buildStatus === undefined || RUNNING_STATUSES.has(buildStatus) || isPaused(buildStatus)
            ? null
            : buildStatus,
      };

      if (paused !== undefined || isPaused(buildStatus)) {
        // A pipeline blocked on `input` never finishes on its own. Reporting
        // it as "still running" after the full timeout is true and useless;
        // naming the stage tells the caller a human has to act.
        inputStage = paused?.name ?? "input";
        return snapshot(false, "input");
      }

      if (buildStatus !== undefined && !RUNNING_STATUSES.has(buildStatus)) {
        cache.invalidateBuild(args.job, ref, selector);
        return snapshot(true);
      }
    } else {
      last = (await res.json()) as ApiBuildState;
      if (last.building !== true) {
        // The build's final state is now knowable, and the cached running one
        // is not - drop it so the next read is the finished build (AGNT-01).
        cache.invalidateBuild(args.job, ref, selector);
        return snapshot(true);
      }
    }

    // An abort raised DURING the request is caught at the top of the next
    // iteration: `sleep` returns at once for an already-aborted signal, so
    // that costs a tick rather than another full round trip.
    if (Date.now() - start >= timeoutMs) return snapshot(false, "timeout");

    await sleep(delayMs, args.signal);
    delayMs = Math.min(delayMs * BACKOFF_MULTIPLIER, MAX_POLL_MS);
  }
}

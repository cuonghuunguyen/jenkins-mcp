/**
 * Build-log formatter (READ-10/READ-11, AGNT-03/AGNT-04/AGNT-05).
 *
 * Three things this layer guarantees, because the log tool is the one an agent
 * calls most and the one most able to flood a context window:
 *
 * 1. The header always says which slice of the whole log came back, so a
 *    partial read is never mistaken for the complete log.
 * 2. Line numbers are the ORIGINAL log's, so the follow-up call an agent makes
 *    (`mode=range from=... to=...`) addresses the right lines.
 * 3. A body that hits either cap ends with the exact call that returns the
 *    rest - never a dead end.
 */

import type { LogResult, LogSegment } from "../operations/log.js";
import { capBytes, emptyState, numberLines, withNext } from "./common.js";

/**
 * Rendered-line cap. 200 numbered log lines is roughly a screen and a half of
 * reading and comfortably under the byte cap for ordinary lines; past that an
 * agent is scrolling rather than diagnosing, and `mode=grep` is the better
 * question to ask.
 */
export const MAX_LOG_LINES = 200;

/**
 * Byte cap, applied after the line cap because one pathological log line
 * (a base64 blob, a minified bundle) can be megabytes on its own. 40KB is
 * ~10k tokens: more than `jenkins_diagnose_build`'s 18KB region, since a log
 * read is a deliberate ask rather than an automatic extraction, but still a
 * bounded fraction of a context window.
 */
export const LOG_CAP_BYTES = 40_000;

/** Renders a job/ref pair as the compact address form used in log output. */
function address(job: string, ref?: string): string {
  return ref === undefined || ref === "" ? job : `${job}/${ref}`;
}

function countLines(segments: LogSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.lines.length, 0);
}

/**
 * Caps segments at `maxLines` REAL log lines.
 *
 * Two things the old line-count-after-join truncation got wrong and this
 * fixes. It counted the `...` group separators as log lines, so a truncated
 * multi-group grep reported a total that belonged to neither the log nor the
 * window. And it always kept the HEAD, which for `tail` and `failed` throws
 * away the exact end of the log the caller asked for. `fromEnd` picks the
 * surviving end; the caller then derives the header and the retrieval hint
 * from what actually survived, so the two can no longer contradict the body.
 */
function capSegments(segments: LogSegment[], maxLines: number, fromEnd: boolean): LogSegment[] {
  if (countLines(segments) <= maxLines) return segments;

  const out: LogSegment[] = [];
  let budget = maxLines;

  if (fromEnd) {
    for (let i = segments.length - 1; i >= 0 && budget > 0; i--) {
      const segment = segments[i];
      if (segment === undefined) continue;
      const take = Math.min(budget, segment.lines.length);
      out.unshift({
        startLine: segment.startLine + segment.lines.length - take,
        lines: segment.lines.slice(segment.lines.length - take),
      });
      budget -= take;
    }
    return out;
  }

  for (const segment of segments) {
    if (budget <= 0) break;
    const take = Math.min(budget, segment.lines.length);
    out.push({ startLine: segment.startLine, lines: segment.lines.slice(0, take) });
    budget -= take;
  }
  return out;
}

/** First and last ORIGINAL line numbers covered by a segment list. */
function span(segments: LogSegment[]): { first: number; last: number } {
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  return {
    first: firstSegment?.startLine ?? 1,
    last: (lastSegment?.startLine ?? 1) + (lastSegment?.lines.length ?? 1) - 1,
  };
}

/**
 * The call that returns the lines this render DROPPED (AGNT-04).
 *
 * Derived from the dropped range, not from the window's start: the previous
 * version computed `first - MAX .. first - 1`, which for a head-truncated
 * range named the very lines just shown - an agent following it loops forever.
 */
function retrievalCall(data: LogResult, kept: LogSegment[]): string {
  // A byte cursor's line numbers are chunk-relative, so no `mode=range` call
  // addresses the dropped lines. Writing the whole log out does.
  if (data.chunkRelative === true) {
    return "{log} with save_to='' to write the full log to a file";
  }
  // Same for the wfapi stage route: the numbers are the STAGE log's, and
  // `mode=range` reads the console.
  if (data.mode === "step" && data.stepRoute === "wfapi") {
    return `{log} with mode=step step=${data.step} save_to='' to write the stage log to a file`;
  }
  // A wider grep context is what made this too long; only worth suggesting
  // when the current context is actually wider than zero.
  if (data.mode === "grep" && data.pattern !== undefined && (data.context ?? 0) > 0) {
    return `{log} with mode=grep pattern=${data.pattern} context=0`;
  }

  const whole = span(data.segments);
  const shown = span(kept);
  // `tail`/`failed` keep the END, so the dropped lines are the older ones.
  return shown.first > whole.first
    ? `{log} with mode=range from=${whole.first} to=${shown.first - 1}`
    : `{log} with mode=range from=${shown.last + 1} to=${whole.last}`;
}

/** Numbers each segment from its own original start line, `...` between groups. */
function renderSegments(segments: LogSegment[]): string {
  return segments
    .map((segment) => numberLines(segment.lines.join("\n"), segment.startLine))
    .join("\n...\n");
}

/** The "which slice came back" half of the header. */
function sliceLabel(data: LogResult, shown: number, first: number, last: number): string {
  if (data.mode === "grep") {
    // "the log has N matches" and "we stopped looking after N" are different
    // facts. Reporting the second as the first is the failure mode this
    // codebase keeps closing off, so the early stop is stated outright.
    const found =
      data.scanStoppedEarly === true
        ? `${data.matchCount ?? 0}+ match(es) — scan stopped at max_matches=${data.maxMatches} ` +
          `after ${data.scannedLines ?? 0} of ${data.totalLines} lines`
        : `${data.matchCount ?? 0} match(es)`;
    return `${found}, showing ${shown} of ${data.totalLines} lines`;
  }
  if (data.chunkRelative === true) {
    // A byte cursor gives no line count for the bytes it skipped, so these
    // numbers describe the returned chunk, not the whole log.
    return `chunk lines ${first}-${last} (${data.totalLines} new)`;
  }
  if (data.mode === "step" && data.stepRoute === "wfapi") {
    // Numbered within the STAGE log, not the console - a `mode=range` follow-up
    // would address entirely different text.
    return `stage lines ${first}-${last} of ${data.totalLines}`;
  }
  return `lines ${first}-${last} of ${data.totalLines}`;
}

/** Follow-up calls, chosen so none of them addresses the wrong numbering space. */
function hintsFor(data: LogResult): string[] {
  if (data.building && data.nextCursor !== undefined) {
    return [
      `{log} with cursor=${data.nextCursor} for the next chunk`,
      "{wait} to follow this build",
    ];
  }
  if (data.mode === "step" && data.stepRoute === "wfapi") {
    return [
      "{log} with mode=tail to read the build's console instead of this stage",
      "{build} for the failure summary",
    ];
  }
  if (data.mode === "grep") {
    return [
      "{log} with mode=range around a hit for its surrounding lines",
      "{build} for the failure summary",
    ];
  }
  return [
    "{log} with mode=grep pattern=ERROR to search the whole log",
    "{build} for the failure summary",
  ];
}

export function formatLogResult(data: LogResult): string {
  const build = data.buildNumber === undefined ? data.selector : `#${data.buildNumber}`;
  const prefix = `${address(data.job, data.ref)} ${build} log`;

  // READ-11: a saved log renders its summary only. Emitting the body too would
  // defeat the entire point of writing it to disk.
  if (data.saved !== undefined) {
    const { savedTo, bytes, lines, firstFailureLine } = data.saved;
    // `undefined` is rendered EXPLICITLY, not as a blank: "no anchored failure
    // line found" is a real answer (a green build, or a failure this scan is
    // deliberately too narrow to claim), and a blank field reads as a bug.
    const failure =
      firstFailureLine === undefined
        ? "no anchored failure line found"
        : `firstFailureLine: ${firstFailureLine}`;
    return withNext(`${prefix}  saved: ${savedTo}  ${bytes} bytes  ${lines} lines  ${failure}`, [
      firstFailureLine === undefined
        ? "{log} with mode=tail to read the end of the log"
        : `{log} with mode=range from=${Math.max(1, firstFailureLine - 20)} to=${firstFailureLine + 40} for the failure`,
      "{log} with mode=grep pattern=ERROR to search the build without re-reading it",
      "{build} for the failure summary",
    ]);
  }

  if (data.segments.length === 0) {
    const empty =
      data.mode === "grep"
        ? emptyState("log lines", data.pattern)
        : emptyState("log lines", data.step);
    return withNext(`${prefix}  mode=${data.mode}\n${empty}`, [
      "{log} with mode=tail to read the end of the log",
      "{build} for the failure summary",
    ]);
  }

  // Truncate FIRST, then describe what survived. Deriving the header from the
  // untruncated segments is what let it claim lines the body never carried.
  // `tail` and `failed` keep the end of the window; every other mode the start.
  const keepEnd = data.mode === "tail" || data.mode === "failed";
  const kept = capSegments(data.segments, MAX_LOG_LINES, keepEnd);
  const shownLines = countLines(kept);
  const allLines = countLines(data.segments);
  const { first, last } = span(kept);

  const next = retrievalCall(data, kept);

  const headerParts = [prefix, `mode=${data.mode}`];
  if (data.step !== undefined) headerParts.push(`step=${data.step} route=${data.stepRoute}`);
  if (data.failedStage !== undefined) headerParts.push(`failedStage=${data.failedStage}`);
  headerParts.push(sliceLabel(data, shownLines, first, last));

  let body = renderSegments(kept);
  if (shownLines < allLines) {
    body += `\n[showing ${shownLines} of ${allLines} lines — next: ${next}]`;
  }
  body = capBytes(body, LOG_CAP_BYTES, next);

  const lines = [headerParts.join("  "), body];

  if (data.hasMore === true && data.nextCursor !== undefined) {
    lines.push(`[more output available — next: {log} with cursor=${data.nextCursor}]`);
  }

  return withNext(lines.join("\n"), hintsFor(data));
}

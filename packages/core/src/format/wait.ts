/**
 * Wait formatter (CTRL-06, Phase 7 criterion 1, AGNT-03/AGNT-04).
 *
 * Four shapes, and the differences between them have to be unmissable: a
 * build that FINISHED, a wait that ran out of time while the build kept
 * going, a wait cut short by a polling failure, and a pipeline PAUSED on an
 * `input` step - the one case where waiting longer cannot help, because a
 * human has to act. Only the last of those is a dead end, and it is the one
 * the old formatter could not say at all.
 *
 * Stage transitions and new log lines render as a compact table and a numbered
 * block, both truncated per the usual contract, and the cursors to pass next
 * are stated plainly rather than left for the caller to derive.
 */

import type { StageTransition, WaitResult } from "../operations/wait.js";
import { formatDuration, listHeader, table, truncateLines, withNext } from "./common.js";

/** Stage rows rendered before the table truncates. */
export const MAX_STAGE_ROWS = 20;

/** New log lines rendered before the block truncates. */
export const MAX_NEW_LOG_LINES = 100;

/** Renders a job/ref pair as the compact address form used in output. */
function address(job: string, ref?: string): string {
  return ref === undefined || ref === "" ? job : `${job} @ ${ref}`;
}

/** The stage-transition table, or nothing when there is no stage data at all. */
function stageSection(data: WaitResult): string[] {
  const stages = data.stages;
  if (stages === undefined) {
    // `undefined` is "no stage data", `[]` is "a pipeline that has started no
    // stage yet" - an agent that cannot tell those apart reads a freestyle
    // build as a pipeline that did nothing.
    return data.wfapiUnavailable === true
      ? ["stages: none (no Pipeline REST API for this build)"]
      : [];
  }
  if (stages.length === 0) return ["stages: none since the cursor"];

  const shown = stages.slice(0, MAX_STAGE_ROWS);
  return [
    listHeader("stages", shown.length, stages.length),
    table(
      ["id", "stage", "status", "duration"],
      shown.map((stage: StageTransition) => [
        stage.id,
        stage.name,
        stage.status,
        formatDuration(stage.durationMs),
      ]),
    ),
  ];
}

/** The new-log-lines block, numbered from the chunk's own start. */
function logSection(data: WaitResult): string[] {
  const lines = data.newLines;
  if (lines === undefined) return [];
  if (lines.length === 0) return ["new log lines: none since the cursor"];

  const body = truncateLines(
    lines.join("\n"),
    MAX_NEW_LOG_LINES,
    "{log} with mode=tail for the end of the log",
  );
  // Numbers are relative to the chunk: a byte cursor says nothing about how
  // many lines preceded it, so these are NOT the console's own line numbers.
  return [
    listHeader(
      "new log lines (since the byte cursor)",
      Math.min(lines.length, MAX_NEW_LOG_LINES),
      lines.length,
    ),
    body,
  ];
}

/** The `next cursor` lines, stated rather than left to be derived. */
function cursorLines(data: WaitResult): string[] {
  const out: string[] = [];
  if (data.nextCursor !== undefined) out.push(`since_cursor: ${data.nextCursor}`);
  if (data.nextLogCursor !== undefined) out.push(`log_cursor: ${data.nextLogCursor}`);
  return out;
}

export function formatWaitResult(data: WaitResult): string {
  const head = `build: ${address(data.job, data.ref)} #${data.number ?? data.selector}`;
  const waited = `waited: ${formatDuration(data.waitedMs)} (${data.polls} polls)`;

  if (!data.finished) {
    const lines = [head];

    if (data.stopped === "input") {
      // Waiting longer cannot help: the build is blocked until a human answers
      // the input step. Saying "still running" here is true and useless.
      lines.push(`status: PAUSED — waiting for input at stage '${data.inputStage ?? "input"}'`);
    } else if (data.stopped === "aborted") {
      lines.push("status: still BUILDING — wait cancelled");
    } else if (data.stopped === "error") {
      lines.push(
        `status: still BUILDING — polling stopped after ${data.transientErrors ?? 0} failed ` +
          `poll(s)${data.lastErrorCode === undefined ? "" : ` (${data.lastErrorCode})`}`,
      );
    } else {
      lines.push("status: still BUILDING — wait timed out");
    }

    lines.push(waited);
    if (data.url) lines.push(`url: ${data.url}`);
    lines.push(...cursorLines(data), ...stageSection(data), ...logSection(data));

    const hints =
      data.stopped === "input"
        ? [
            "a human must answer the input step in the Jenkins UI",
            "{abort} to stop the build instead",
            "{wait} again once the input has been given",
          ]
        : [
            "{wait} again to keep waiting, passing since_cursor and log_cursor",
            "{log} to read the log so far",
            "{abort} to stop the build",
          ];

    return withNext(lines.join("\n"), hints);
  }

  const result = data.result ?? "UNKNOWN";
  const lines = [head, `status: ${result}`, `duration: ${formatDuration(data.durationMs)}`, waited];
  if (data.url) lines.push(`url: ${data.url}`);
  lines.push(...cursorLines(data), ...stageSection(data), ...logSection(data));

  const hints =
    result === "SUCCESS"
      ? ["{log} to read the console log"]
      : ["{diagnose} to isolate the failure", "{log} with mode=failed for the failing lines"];

  return withNext(lines.join("\n"), hints);
}

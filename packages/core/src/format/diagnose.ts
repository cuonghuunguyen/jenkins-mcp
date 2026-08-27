/**
 * Failure-diagnosis formatter (DIAG-03, AGNT-03/AGNT-04/AGNT-05).
 *
 * Section order is the point of this file. The failed-test table goes ABOVE
 * the log region because it is the highest-value part of the output: three
 * short rows naming the exact tests that broke beat two hundred lines of
 * console in which those names are buried.
 *
 * The display cap lives here rather than in the operation, so a `--json`
 * caller receives the real region and its real byte count instead of a string
 * with `[truncated ...]` baked into the data.
 */

import type { DiagnoseResult, DiagnoseTests } from "../operations/diagnose.js";
import {
  capBytes,
  capBytesFromEnd,
  emptyState,
  listHeader,
  numberLines,
  table,
  withNext,
} from "./common.js";

/**
 * Rendered-region byte cap (~18KB, roughly 4-5k tokens). Under
 * `format/log.ts`'s 40KB, because a diagnosis is an automatic extraction the
 * caller did not size, while a log read is a deliberate ask.
 */
export const DIAGNOSE_REGION_CAP_BYTES = 18_000;

/** Maximum characters of a test's failure detail kept inline. */
const DETAIL_CHARS = 90;

/** Renders a job/ref pair as the compact address form used across the output. */
function address(job: string, ref?: string): string {
  return ref === undefined || ref === "" ? job : `${job} @ ${ref}`;
}

/** Collapses a stack trace or multi-line assertion message to one bounded line. */
function oneLine(text: string | undefined): string {
  if (text === undefined) return "";
  const first = (text.split("\n")[0] ?? "").trim();
  return first.length > DETAIL_CHARS ? `${first.slice(0, DETAIL_CHARS)}…` : first;
}

function testSection(tests: DiagnoseTests | undefined): string[] {
  if (tests === undefined) return ["no test report"];
  if (tests.failedTotal === 0) {
    // A matrix or aggregated report carries its failures under `childReports[]`,
    // which this projection does not fetch, so Jenkins' own `failCount` can be
    // non-zero while no failed CASE was parsed. Printing "0 failed" there
    // renders a red build as green.
    if (tests.failCount > 0) {
      return [`tests: ${tests.totalCount} run, ${tests.failCount} failed (details unavailable)`];
    }
    return [`tests: ${tests.totalCount} run, 0 failed`];
  }
  return [
    listHeader("failed tests", tests.failed.length, tests.failedTotal),
    table(
      ["class", "test", "detail"],
      tests.failed.map((test) => [test.className, test.name, oneLine(test.detail)]),
    ),
  ];
}

export function formatDiagnoseResult(data: DiagnoseResult): string {
  const header = `${address(data.job, data.ref)} #${data.number ?? data.selector}`;

  if (data.state === "not-finished") {
    return withNext(`${header}  BUILDING — nothing to diagnose yet`, [
      "{wait} to follow this build to completion",
      "{log} to read the log so far",
    ]);
  }

  if (data.state === "success") {
    return withNext(`${header}  SUCCESS — nothing to diagnose`, [
      "{log} to read the console log anyway",
    ]);
  }

  const lines = [`${header}  ${data.result ?? "FAILED"}`];

  if (data.state === "diagnosed") {
    if (data.failedStage) lines.push(`failedStage: ${data.failedStage}`);
    if (data.failedStep) lines.push(`failedStep: ${data.failedStep}`);
    if (data.failedStage === undefined && data.failedStep === undefined) {
      lines.push("no failed stage reported by wfapi");
    }
  } else {
    lines.push(
      data.reason === "freestyle"
        ? "no stage data (not a pipeline build)"
        : "no stage data (this Jenkins has no Pipeline REST API plugin)",
    );
  }

  if (data.url) lines.push(`url: ${data.url}`);

  // Tests first: they name the failure, the log only contains it.
  lines.push(...testSection(data.tests));

  // The call that would widen the read has to be a real one, and it has to
  // name the mode: a bare "{log}" defaults to a tail and would not widen a
  // step region at all.
  // DIAG-03 deleted the last-error-marker scan from THIS module for being
  // confidently wrong, so pointing a widening read at `{log} mode=failed` -
  // which runs that same heuristic in operations/log.ts - argues against the
  // phase's own reason for the deletion. A console-tail region widens by
  // asking for more tail.
  const wider =
    data.state === "diagnosed" && data.failedStage !== undefined
      ? `{log} with mode=step step=${data.failedStage}`
      : data.region?.source === "console-tail"
        ? "{log} with mode=tail lines=500 for a wider window"
        : "{log} with mode=failed for a wider window";

  if (data.region === undefined) {
    lines.push(emptyState("log region", "this build"));
  } else {
    const region = data.region;
    const label = region.source === "failed-step" ? "failed step log" : "console tail";
    lines.push(`log (${label}, ${region.bytes} bytes, from line ${region.startLine}):`);

    // Cap from the END for a console tail. `toRegion` keeps the end of the
    // console because the failure is there; a front-first byte cap then throws
    // away exactly that, and hands the agent the OLDEST 18KB of the tail -
    // which is the one part guaranteed not to contain the failure. A
    // `failed-step` region is the step's own log and reads head-first.
    const cap = region.source === "console-tail" ? capBytesFromEnd : capBytes;
    const rendered = cap(
      numberLines(region.text, region.startLine),
      DIAGNOSE_REGION_CAP_BYTES,
      wider,
    );
    lines.push(rendered);
  }

  return withNext(lines.join("\n"), [wider, "{trigger} to re-run once the cause is fixed"]);
}

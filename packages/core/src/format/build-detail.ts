/**
 * Build-detail formatter (READ-09, AGNT-03/AGNT-04/AGNT-05).
 *
 * One screen answering "why did this build do that": header, cause,
 * parameters, commits, stages, failed steps, failed tests.
 *
 * The load-bearing rule here is that an ABSENT section and an EMPTY one read
 * differently. A freestyle build has no stage data at all, so it gets no
 * stages section; a pipeline that ran zero stages gets the section with an
 * explicit empty line. Same for the test report - "no test report" is stated
 * rather than left as a silent gap, because an agent that sees no failed-tests
 * section must not conclude the tests passed.
 */

import type { BuildDetail, BuildStage } from "../operations/build-detail.js";
import { emptyState, formatAge, formatDuration, listHeader, table, withNext } from "./common.js";

/** Stage rows shown before the table truncates. */
export const DEFAULT_STAGE_ROWS = 12;

/** Commit rows shown before the table truncates. */
export const DEFAULT_COMMIT_ROWS = 10;

/** Failed-step lines shown before the list truncates. */
export const DEFAULT_FAILED_STEP_ROWS = 5;

/** Maximum characters of a test's `errorDetails` kept inline. */
const DETAIL_CHARS = 90;

/** Renders a job/ref pair as the compact address form used across the output. */
function address(job: string, ref?: string): string {
  return ref === undefined || ref === "" ? job : `${job} @ ${ref}`;
}

/**
 * Collapses a multi-line assertion message to one bounded line. A JUnit
 * `errorDetails` can be a full stack trace, which would dwarf the table.
 */
function oneLine(text: string | undefined): string {
  if (text === undefined) return "";
  const first = (text.split("\n")[0] ?? "").trim();
  return first.length > DETAIL_CHARS ? `${first.slice(0, DETAIL_CHARS)}…` : first;
}

function shortCommit(commitId: string): string {
  return commitId.slice(0, 7);
}

/** The stages a caller has to act on: exactly those Jenkins marked FAILED. */
function failedStages(stages: BuildStage[]): BuildStage[] {
  return stages.filter((stage) => stage.status === "FAILED");
}

function parameterSection(data: BuildDetail): string[] {
  if (data.parameters.length === 0) return [emptyState("parameters")];
  return [
    listHeader("params", data.parameters.length, data.parameters.length),
    table(
      ["name", "value"],
      data.parameters.map((param) => [param.name, param.value]),
    ),
  ];
}

function commitSection(data: BuildDetail): string[] {
  if (data.commits.length === 0) return [emptyState("commits")];
  const shown = data.commits.slice(0, DEFAULT_COMMIT_ROWS);
  return [
    listHeader("commits", shown.length, data.commits.length),
    table(
      ["commit", "author", "message"],
      shown.map((commit) => [
        shortCommit(commit.commitId),
        commit.author ?? "",
        oneLine(commit.message),
      ]),
    ),
  ];
}

/**
 * Orders stages for a TRUNCATED table so the rows that survive are the ones a
 * caller has to act on.
 *
 * Chronological order is the right default and is kept whenever the whole
 * table fits. Once it does not, a head-first slice of a 20-stage pipeline that
 * failed in stage 19 renders twelve SUCCESS rows and nothing else - every
 * visible signal says the build was fine. Sorting non-SUCCESS first is a
 * smaller change than a retrieval hint and removes the need for one, since
 * nothing actionable can be dropped.
 */
function orderedForTruncation(stages: BuildStage[]): BuildStage[] {
  if (stages.length <= DEFAULT_STAGE_ROWS) return stages;
  return [...stages].sort(
    (a, b) => Number(a.status === "SUCCESS") - Number(b.status === "SUCCESS"),
  );
}

function stageSection(stages: BuildStage[]): string[] {
  if (stages.length === 0) return [emptyState("stages")];
  const shown = orderedForTruncation(stages).slice(0, DEFAULT_STAGE_ROWS);
  return [
    listHeader("stages", shown.length, stages.length),
    table(
      ["stage", "status", "duration"],
      shown.map((stage) => [stage.name, stage.status, formatDuration(stage.durationMs)]),
    ),
  ];
}

function failedStepSection(stages: BuildStage[]): string[] {
  const failed = failedStages(stages);
  if (failed.length === 0) return [emptyState("failed steps")];
  const shown = failed.slice(0, DEFAULT_FAILED_STEP_ROWS);
  return [
    listHeader("failed steps", shown.length, failed.length),
    ...shown.map((stage) => `${stage.name} — see {log} with mode=step step=${stage.name}`),
  ];
}

function testSection(data: BuildDetail): string[] {
  const tests = data.tests;
  if (tests === undefined) return ["no test report"];
  if (tests.failedTotal === 0) {
    // A matrix, multi-config or aggregated report carries its failures under
    // `childReports[]`, which this projection does not fetch, so no failed CASE
    // is parsed while Jenkins' own `failCount` says there were failures.
    // Reporting "0 failed" there renders a red build as green.
    if (tests.failCount > 0) {
      return [
        `tests: ${tests.totalCount} run, ${tests.failCount} failed ` +
          "(details unavailable — {log} with mode=failed)",
      ];
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

/** `next:` hints, chosen from the build's outcome rather than its shape. */
function hintsFor(data: BuildDetail): string[] {
  if (data.building) {
    return ["{wait} to follow this build to completion", "{log} to read the log so far"];
  }
  if (data.result === "SUCCESS") return ["{log} to read the console log"];
  return ["{log} with mode=failed for the failure context", "{diagnose} for a root-cause summary"];
}

export function formatBuildDetail(data: BuildDetail, now = Date.now()): string {
  const status = data.building ? "BUILDING" : (data.result ?? "UNKNOWN");

  // Jenkins reports `duration: 0` for a build still in flight, so elapsed time
  // has to be derived from the start timestamp instead.
  const elapsedMs =
    data.building && data.timestamp !== undefined ? now - data.timestamp : data.durationMs;

  const lines = [
    `${address(data.job, data.ref)} #${data.number ?? data.selector}  ${status}  ` +
      `${formatDuration(elapsedMs)}  ${formatAge(data.timestamp, now)} ago`,
  ];

  if (data.causes.length > 0) lines.push(`cause: ${data.causes.join("; ")}`);

  lines.push(...parameterSection(data));
  lines.push(...commitSection(data));

  // Absent vs empty: no stages section at all for a build that has no stage
  // DATA, one explicit line for a pipeline that genuinely ran none.
  if (data.stages === undefined) {
    lines.push(data.pipeline ? "no stage data (wfapi unavailable)" : "no stages (not a pipeline)");
  } else {
    lines.push(...stageSection(data.stages));
    lines.push(...failedStepSection(data.stages));
  }

  lines.push(...testSection(data));
  if (data.url !== undefined) lines.push(`url: ${data.url}`);

  return withNext(lines.join("\n"), hintsFor(data));
}

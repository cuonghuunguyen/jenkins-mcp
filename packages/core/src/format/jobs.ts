/**
 * Job index formatters (AGNT-02/AGNT-03/AGNT-04).
 *
 * Four columns per row, counts always stated, depth-cap truncation reported
 * explicitly rather than left implicit in a short list.
 */

import type { JobSearchResult } from "../operations/jobs.js";
import type { IndexedJob, JobIndex } from "../types.js";
import { depthCapNotice, emptyState, formatAge, listHeader, table, withNext } from "./common.js";

/** Default rows shown before the list truncates. */
export const DEFAULT_JOB_ROWS = 20;

/**
 * Row columns for the job index (Phase 6 criterion 1:
 * `fullName type status lastBuild age`).
 *
 * That is five fields and AGNT-03 caps a row at four, so `type` and `status`
 * share one `pipeline/failed` column - they are the two halves of one answer
 * ("what is it, and how is it doing") and read fine together, whereas
 * `lastBuild` and `age` are the pair that distinguishes a live job from an
 * abandoned one and cannot be collapsed into anything. `depth` was dropped
 * for the same budget: it is not in the criterion, and the depth CAP - the
 * part that matters - is still reported by its own notice line.
 */
const JOB_HEADERS = ["fullName", "type/status", "lastBuild", "age"];

function jobRows(jobs: IndexedJob[]): string[][] {
  return jobs.map((job) => {
    // A folder has no builds and a never-run job has none either. Both render
    // "-": inventing a #0 would make an abandoned job look like a fresh one.
    const last = job.lastBuild;
    return [
      job.fullName,
      `${job.type}/${job.status}`,
      last === undefined ? "-" : `#${last.number}${last.result === null ? " (running)" : ""}`,
      last === undefined ? "-" : formatAge(last.timestamp),
    ];
  });
}

/**
 * Renders the job index as a table, appending the depth-cap notice when
 * containers went unexpanded - an incomplete index must never read as a
 * complete one.
 */
export function formatJobIndex(index: JobIndex, limit = DEFAULT_JOB_ROWS): string {
  if (index.total === 0) {
    return withNext(emptyState("jobs"), [
      "{whoami} to confirm the credentials resolve to an account that can see jobs",
    ]);
  }

  const shown = index.jobs.slice(0, limit);
  const lines = [listHeader("jobs", shown.length, index.total), table(JOB_HEADERS, jobRows(shown))];

  if (index.droppedFolders.length > 0) {
    lines.push(
      `[${index.droppedFolders.length} folder(s) not expanded at depth cap ${index.depthCap}: ` +
        `${index.droppedFolders.slice(0, 5).join(", ")} — raise JENKINS_INDEX_DEPTH to include them]`,
    );
  }

  return withNext(lines.join("\n"), [
    "{job} to inspect one job's parameters and recent builds",
    "{build} to inspect a specific build",
  ]);
}

/** Renders a job search result (READ-07). */
export function formatJobSearch(data: JobSearchResult): string {
  if (data.matches.length === 0) {
    return withNext(emptyState("jobs", data.query === undefined ? undefined : `'${data.query}'`), [
      `{findJobs} with a shorter query (${data.total} jobs indexed)`,
    ]);
  }

  const lines = [
    listHeader("jobs", data.matches.length, data.matched),
    table(JOB_HEADERS, jobRows(data.matches)),
  ];

  const notice = depthCapNotice(data.depthCap, data.droppedFolders);
  if (notice !== "") lines.push(notice);

  return withNext(lines.join("\n"), [
    "{job} to inspect one job's parameters and recent builds",
    "{build} to inspect a specific build",
  ]);
}

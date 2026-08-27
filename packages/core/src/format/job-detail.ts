/**
 * Job-detail formatters (READ-08, REF-02, AGNT-03/04/05).
 *
 * Two renderings behind one entry point, matching the two shapes
 * `getJobDetail` can return. The `kind` discriminant is what makes that safe:
 * an agent never has to guess which table it is reading, and neither does this
 * module.
 */

import type {
  JobBuildSummary,
  JobDetail,
  JobDetailContainer,
  JobDetailJob,
  JobParameter,
} from "../operations/job-detail.js";
import {
  depthCapNotice,
  emptyState,
  formatAge,
  formatDuration,
  listHeader,
  table,
  withNext,
} from "./common.js";

/** Rows shown before the children table truncates. */
const DEFAULT_CHILD_ROWS = 20;

/**
 * The result column. A running build's `result` still names the PREVIOUS
 * outcome (Jenkins only writes the new one when the build finishes), so
 * reporting it verbatim would show a stale SUCCESS next to a build that is
 * still going.
 */
function resultOf(build: JobBuildSummary): string {
  if (build.building) return "BUILDING";
  return build.result ?? "-";
}

/** The `default` cell: the default value, plus a choice parameter's options. */
function defaultCell(param: JobParameter): string {
  const value = param.defaultValue ?? "";
  const choices = param.choices;
  if (choices === undefined || choices.length === 0) return value;
  return `${value} (${choices.join("|")})`;
}

function formatJob(data: JobDetailJob): string {
  const lines = [
    `${data.fullName}  ${data.type}  ${data.buildable ? "buildable" : "not-buildable"}`,
  ];

  if (data.parameters.length === 0) {
    lines.push(emptyState("parameters"));
  } else {
    lines.push(
      listHeader("params", data.parameters.length, data.parameters.length),
      table(
        ["name", "type", "default"],
        // Choices go in the default cell rather than a fourth column: a caller
        // preparing a {trigger} call needs the accepted values, and the row
        // limit is four fields.
        data.parameters.map((param) => [param.name, param.type, defaultCell(param)]),
      ),
    );
  }

  if (data.builds.length === 0) {
    lines.push(emptyState("builds"));
  } else {
    lines.push(
      // `builds` is capped server-side at 10; `totalBuilds` is what the job
      // has actually run, so a truncated list is never labelled complete.
      listHeader("builds", data.builds.length, data.totalBuilds ?? data.builds.length),
      table(
        ["#", "result", "age", "duration"],
        data.builds.map((build) => [
          build.number === undefined ? "-" : String(build.number),
          resultOf(build),
          formatAge(build.timestamp),
          formatDuration(build.durationMs),
        ]),
      ),
    );
  }

  return withNext(lines.join("\n"), [
    "{build} to inspect a build",
    "{log} to read a build log",
    data.buildable ? "{trigger} to start a build" : "",
  ]);
}

/**
 * Strips the container prefix so the table shows "main", not "team-a/svc/main",
 * and decodes it so the printed name is the one a caller can pass back as
 * `ref`.
 *
 * A multibranch child for `release/1.x` is reported by Jenkins with a `%2F` in
 * its name (D-07), and `release%2F1.x` passed back as `ref` re-encodes to
 * `%252F` and 404s. UNVERIFIED whether every instance encodes it that way -
 * decoding is a no-op when it does not, hence the guard rather than a branch.
 */
function childName(job: string, fullName: string): string {
  const prefix = `${job}/`;
  const name = fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function formatContainer(data: JobDetailContainer): string {
  if (data.total === 0) {
    // A container the index never expanded looks byte-identical to a genuinely
    // empty one unless the cap is stated here too - and the answer an agent
    // draws from the two is opposite.
    const capped = depthCapNotice(data.depthCap, data.droppedFolders);
    const empty = `${data.job}  ${data.type} (0)\n${emptyState("branches")}`;
    return withNext(capped === "" ? empty : `${empty}\n${capped}`, [
      "{findJobs} to check the job index sees this container's children",
    ]);
  }

  const shown = data.children.slice(0, DEFAULT_CHILD_ROWS);
  const lines = [
    `${data.job}  ${listHeader(data.type, shown.length, data.total)}`,
    table(
      ["name", "status", "type"],
      shown.map((child) => [childName(data.job, child.fullName), child.status, child.type]),
    ),
  ];

  const notice = depthCapNotice(data.depthCap, data.droppedFolders);
  if (notice !== "") lines.push(notice);

  return withNext(lines.join("\n"), [
    "{job} with ref=<name> for one branch",
    "{build} with ref=<name> for its last build",
    shown.length < data.total ? `{findJobs} with '${data.job}/' for the remaining children` : "",
  ]);
}

/** Renders one job: its children if it is a container, else its detail. */
export function formatJobDetail(data: JobDetail): string {
  return data.kind === "container" ? formatContainer(data) : formatJob(data);
}

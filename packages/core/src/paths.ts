/**
 * Job-path resolver and build addressing - the single choke point every
 * operation routes job references through (CONN-04, REF-01, D-06/D-07).
 *
 * Two layers live here:
 *
 * 1. The v1 segment model. A job reference is a human-friendly path string
 *    ("folderA/folderB/my-job"). A literal "/" is a folder-nesting boundary;
 *    a "/" *inside* a single multibranch branch name is expected to already
 *    be `%2F`-encoded by the caller (D-07), and this module preserves that
 *    escape rather than re-splitting or double-encoding it.
 *
 * 2. The v2 `job` + `ref` model (REF-01). `job` is a Jenkins fullName; `ref`
 *    is a branch, tag, or PR name belonging to a multibranch parent and is
 *    encoded with `encodeURIComponent`, so a caller passes the raw branch
 *    name ("feature/foo") and never has to pre-encode anything. This is the
 *    addressing every v2 tool takes, and it is why `jobRestPath` replaces the
 *    hand-prepended `/job/` + `jobPath(parsePathString(...))` idiom that was
 *    duplicated at four call sites in v1.
 */

import { JenkinsError } from "./errors.js";

/**
 * Splits a human-friendly job-path string into its segment array.
 *
 * A literal "/" is a segment boundary. A `%2F` (or any other percent-escape)
 * embedded inside a segment is left intact - it is not a literal "/" and is
 * therefore never split. Empty segments produced by leading, trailing, or
 * repeated slashes are dropped.
 */
export function parsePathString(input: string): string[] {
  return input.split("/").filter((segment) => segment.length > 0);
}

/**
 * Joins parsed segments into the Jenkins REST job path form, where each
 * folder level after the first is separated by `/job/`.
 *
 * Each segment is passed through `encodeSegment` first so a caller-supplied
 * `%2F`-encoded branch slash (D-07) is preserved as-is rather than being
 * re-encoded into `%252F`.
 */
export function jobPath(segments: string[]): string {
  return segments.map((segment) => encodeSegment(segment)).join("/job/");
}

/**
 * Escapes a literal `%` that is not already part of a valid percent-escape
 * (e.g. the `%2F` a caller pre-encodes for a multibranch branch-name slash
 * per D-07), so re-running this segment through the resolver never turns
 * `%2F` into `%252F`.
 */
export function encodeSegment(segment: string): string {
  return segment.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
}

/**
 * Resolves a `job` fullName plus optional `ref` to a Jenkins REST job path,
 * including the leading `/job/` (REF-01).
 *
 * `ref` is appended as its own `/job/<encodeURIComponent(ref)>` level, since
 * a multibranch branch/PR/tag is a child job of the multibranch parent. Full
 * `encodeURIComponent` is correct for a ref (unlike a folder segment) because
 * a ref arrives raw: "feature/foo" must become "feature%2Ffoo", and a ref can
 * never itself contain a folder boundary.
 */
export function jobRestPath(job: string, ref?: string): string {
  const base = `/job/${jobPath(parsePathString(job))}`;
  if (ref === undefined || ref === "") return base;
  return `${base}/job/${encodeURIComponent(ref)}`;
}

/**
 * Jenkins build permalink aliases, resolved server-side. Accepted anywhere a
 * build number is accepted (REF-01), so an agent can address "the last failed
 * build" without first reading the build list to find its number.
 */
export const PERMALINK_ALIASES = [
  "lastBuild",
  "lastCompletedBuild",
  "lastSuccessfulBuild",
  "lastStableBuild",
  "lastFailedBuild",
  "lastUnsuccessfulBuild",
] as const;

export type PermalinkAlias = (typeof PERMALINK_ALIASES)[number];

function isPermalinkAlias(value: string): value is PermalinkAlias {
  return (PERMALINK_ALIASES as readonly string[]).includes(value);
}

/**
 * Normalizes a caller-supplied `ref` (REF-01).
 *
 * A bare integer ref on a multibranch job means a pull request: `ref: 42` on
 * a multibranch parent addresses the `PR-42` child job, because an agent that
 * has just read "PR-42" from a Bitbucket/GitHub context naturally passes the
 * number. On a non-multibranch job an integer ref is meaningless, so it is
 * passed through untouched and will simply fail to resolve as a branch name -
 * rather than being silently rewritten into a job that does not exist.
 */
export function normalizeRef(
  ref: string | number | undefined,
  isMultibranch: boolean,
): string | undefined {
  if (ref === undefined) return undefined;
  const raw = String(ref).trim();
  if (raw === "") return undefined;
  if (isMultibranch && /^\d+$/.test(raw)) return `PR-${raw}`;
  return raw;
}

/**
 * Resolves a caller-supplied build selector to the path segment Jenkins
 * understands (REF-01): a positive build number, `-1` as a shorthand for the
 * most recent build, or any permalink alias.
 *
 * Returns a string because every accepted form ends up as one URL path
 * segment; the aliases are resolved by Jenkins itself, so no extra request is
 * needed to turn "lastFailedBuild" into a number.
 */
export function resolveBuildSelector(build: string | number | undefined): string {
  if (build === undefined || build === "" || build === -1 || build === "-1") {
    return "lastBuild";
  }

  if (typeof build === "number") {
    if (Number.isInteger(build) && build > 0) return String(build);
    throw new JenkinsError(
      `Invalid build selector '${build}'. Use a positive build number, -1 for the ` +
        `most recent build, or one of: ${PERMALINK_ALIASES.join(", ")}.`,
      "resolve_build",
      undefined,
      "invalid_input",
    );
  }

  const raw = build.trim();
  if (/^\d+$/.test(raw) && Number.parseInt(raw, 10) > 0) return raw;
  if (isPermalinkAlias(raw)) return raw;

  throw new JenkinsError(
    `Invalid build selector '${raw}'. Use a positive build number, -1 for the ` +
      `most recent build, or one of: ${PERMALINK_ALIASES.join(", ")}.`,
    "resolve_build",
    undefined,
    "invalid_input",
  );
}

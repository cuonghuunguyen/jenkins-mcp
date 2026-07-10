/**
 * Job-path resolver — the single choke point every tool routes job references
 * through (CONN-04, D-06/D-07).
 *
 * Tools accept a human-friendly path string ("folderA/folderB/my-job"). A
 * literal "/" is a folder-nesting boundary; a "/" *inside* a single
 * multibranch branch name is expected to already be `%2F`-encoded by the
 * caller (D-07), and this module preserves that escape rather than
 * re-splitting or double-encoding it.
 */

/**
 * Splits a human-friendly job-path string into its segment array.
 *
 * A literal "/" is a segment boundary. A `%2F` (or any other percent-escape)
 * embedded inside a segment is left intact — it is not a literal "/" and is
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

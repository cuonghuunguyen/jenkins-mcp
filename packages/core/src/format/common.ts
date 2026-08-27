/**
 * Shared output primitives enforcing the agent-ergonomic contract
 * (AGNT-03/AGNT-04/AGNT-05, https://axi.md/).
 *
 * Every formatter in this package builds its text from these helpers rather
 * than hand-rolling layout, because the contract is only useful if it is
 * uniform: an agent that learns to read one result can read all of them.
 *
 * The five rules these encode:
 *
 * 1. Compact tables, not JSON dumps. A list row shows at most four fields.
 * 2. Every list states `total` and `shown`, so a truncated list is never
 *    mistaken for a complete one.
 * 3. Truncated text ends with a size hint AND the exact call that retrieves
 *    the rest - an escape hatch, not a dead end.
 * 4. Zero results print an explicit line, so "no matches" is distinguishable
 *    from a silent failure.
 * 5. Every result ends with 1-3 `next:` lines naming concrete calls, and
 *    every error is `error: <code> - <message> - try: <call>`.
 */

import { JenkinsError } from "../errors.js";

/** Column separator - two spaces, so columns stay scannable without box drawing. */
const COLUMN_GAP = "  ";

/**
 * Renders a header row plus body rows as a space-aligned table.
 *
 * Columns are padded to their widest cell, except the last column, which is
 * never padded (trailing whitespace is wasted tokens). A cell is coerced to
 * "-" when empty so a row never collapses into ambiguity.
 */
export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows.map((row) => row.map((cell) => (cell === "" ? "-" : cell)))];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)),
  );

  return all
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join(COLUMN_GAP)
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Builds a list header carrying the pre-computed aggregate counts every list
 * must report: `label (N)` when complete, `label (showing N of M)` when not.
 */
export function listHeader(label: string, shown: number, total: number): string {
  return shown < total ? `${label} (showing ${shown} of ${total})` : `${label} (${total})`;
}

/**
 * The explicit zero-result line. An agent must be able to tell "the query
 * matched nothing" from "the tool returned nothing because it broke".
 */
export function emptyState(thing: string, query?: string): string {
  return query === undefined || query === "" ? `No ${thing} found` : `No ${thing} matched ${query}`;
}

/**
 * Appends `next:` lines naming concrete calls the caller can make from here.
 * Capped at three: past that it stops being guidance and becomes noise.
 */
export function withNext(body: string, hints: string[]): string {
  const lines = hints.filter((hint) => hint.length > 0).slice(0, 3);
  if (lines.length === 0) return body;
  return `${body}\n${lines.map((hint) => `next: ${hint}`).join("\n")}`;
}

/** Prefixes each line with a right-aligned line number, starting at `startAt`. */
export function numberLines(text: string, startAt = 1): string {
  const lines = text.split("\n");
  const width = String(startAt + lines.length - 1).length;
  return lines
    .map((line, offset) => `${String(startAt + offset).padStart(width)}  ${line}`)
    .join("\n");
}

/**
 * Truncates text to `maxLines`, ending with the size hint and the exact call
 * that returns the rest (AGNT-04). `nextCall` must be a real, copy-pasteable
 * call - a vague "request more lines" defeats the point.
 */
export function truncateLines(text: string, maxLines: number, nextCall: string): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join("\n");
  return `${kept}\n[showing ${maxLines} of ${lines.length} lines — next: ${nextCall}]`;
}

/**
 * Caps text at a UTF-8 byte budget, ending with a size hint naming how to
 * narrow the request. Salvaged from the deleted `jenkins_bash` output cap;
 * bytes rather than lines, because a context budget is spent in bytes and one
 * pathological log line can be megabytes.
 */
export function capBytes(text: string, capBytes: number, nextCall: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= capBytes) return text;

  // Back off to a codepoint boundary before decoding. Cutting mid-sequence
  // decodes to U+FFFD, so the last visible character of a capped body would be
  // a replacement char rather than merely absent - and for a truncated
  // config.xml the trailing bytes would be silently corrupt. A UTF-8
  // continuation byte is 0b10xxxxxx; at most three precede a boundary.
  let end = capBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;

  const dropped = buf.length - end;
  return (
    `${buf.subarray(0, end).toString("utf8")}\n` +
    `[truncated ${dropped} of ${buf.length} bytes — next: ${nextCall}]`
  );
}

/**
 * Caps text at a UTF-8 byte budget keeping the END rather than the start.
 *
 * The mirror of `capBytes`, for a body whose whole value is at its end - a
 * console tail is returned precisely because the failure is in its last lines,
 * so a front-first cap drops the one part the caller asked for. The cut is
 * aligned forward to a codepoint boundary (a mid-sequence slice decodes to
 * U+FFFD) and then to the next line break, so the surviving body never starts
 * with half a line - which, once line numbers are prefixed, would read as a
 * numbered line that is not the line it names.
 */
export function capBytesFromEnd(text: string, budgetBytes: number, nextCall: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budgetBytes) return text;

  let start = buf.length - budgetBytes;
  // A UTF-8 continuation byte is 0b10xxxxxx; at most three precede a boundary.
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;

  const newline = buf.indexOf(0x0a, start);
  if (newline !== -1 && newline + 1 < buf.length) start = newline + 1;

  const dropped = start;
  return (
    `[truncated ${dropped} of ${buf.length} bytes from the START — next: ${nextCall}]\n` +
    `${buf.subarray(start).toString("utf8")}`
  );
}

/**
 * Renders any thrown value as one structured error line (AGNT-05):
 * `error: <code> - <message> - try: <call>`.
 *
 * The message comes from `JenkinsError`, which is built only from a status and
 * an operation label, so a token, crumb or cookie value can never reach this
 * string. A non-JenkinsError is reported as `internal` with its own message
 * withheld, since an arbitrary thrown value may echo request details.
 */
export function formatErrorLine(err: unknown, tryHint?: string): string {
  if (err instanceof JenkinsError) {
    const hint = err.tryHint ?? tryHint;
    const suffix = hint === undefined ? "" : ` — try: ${hint}`;
    return `error: ${err.code} — ${err.message}${suffix}`;
  }

  const suffix = tryHint === undefined ? "" : ` — try: ${tryHint}`;
  return `error: internal — An unexpected error occurred${suffix}`;
}

/**
 * Renders a millisecond duration compactly: "1.4s", "3m20s", "1h04m".
 * Durations are read at a glance far more often than they are computed with.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Renders an epoch-millisecond timestamp as an age relative to `now`
 * ("4m", "3h", "2d"). An age is what a caller actually reasons about when
 * scanning a build list; an absolute timestamp costs more tokens and still
 * needs mental arithmetic.
 */
export function formatAge(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined || timestamp <= 0) return "-";

  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}

/**
 * Renders the index depth-cap notice, or an empty string when nothing was
 * dropped. Shared because both the job search and the job-detail container
 * view read the same truncated index, and AGNT-02's rule is that an index may
 * be incomplete but never SILENTLY incomplete - two copies of this string is
 * two chances for one of them to drift out of that guarantee.
 */
export function depthCapNotice(depthCap: number, droppedFolders: string[]): string {
  if (droppedFolders.length === 0) return "";
  return (
    `[${droppedFolders.length} folder(s) not expanded at depth cap ${depthCap}: ` +
    `${droppedFolders.slice(0, 5).join(", ")} — raise JENKINS_INDEX_DEPTH to include them]`
  );
}

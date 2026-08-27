/**
 * Queue listing formatter (AGNT-03/AGNT-04).
 *
 * Four columns, counts always stated, and an explicit empty line - an empty
 * queue is the common case and must not read like a failed request.
 */

import type { QueuedItem, QueueItemState, QueueListing } from "../operations/queue-list.js";
import { emptyState, formatDuration, listHeader, table, withNext } from "./common.js";

/** Rows shown before the listing truncates. */
export const DEFAULT_QUEUE_ROWS = 20;

/**
 * Keeps a row on one line. `why` is a free-form Jenkins string that can carry
 * newlines (a blocked-by-upstream reason does), which would break the table.
 */
function firstLine(text: string | null): string {
  return (text ?? "").split("\n")[0] ?? "";
}

/**
 * Truncation order. The listing preserves Jenkins' own order, so a head-first
 * slice of a 25-item queue can drop the single `stuck` item the tool exists to
 * surface - and no call in the product returns rows 21-25, because `listQueue`
 * takes no offset. Sorting by actionability first means the cap can only ever
 * drop the least interesting rows.
 */
const STATE_PRIORITY: Record<QueueItemState, number> = {
  stuck: 0,
  blocked: 1,
  buildable: 2,
  waiting: 3,
};

function byActionability(items: QueuedItem[]): QueuedItem[] {
  return [...items].sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state]);
}

function queueRows(items: QueuedItem[]): string[][] {
  return items.map((item) => [
    item.jobFullName ?? "(not visible)",
    item.state,
    formatDuration(item.waitingFor),
    firstLine(item.why),
  ]);
}

export function formatQueueListing(data: QueueListing, limit = DEFAULT_QUEUE_ROWS): string {
  if (data.total === 0) {
    return withNext(emptyState("queued items"), [
      "{findJobs} to locate a job, then {trigger} to start a build",
    ]);
  }

  const shown = byActionability(data.items).slice(0, limit);
  const dropped = data.total - shown.length;
  const body = [
    listHeader("queue", shown.length, data.total),
    table(["job", "state", "waiting", "why"], queueRows(shown)),
    dropped === 0
      ? ""
      : `[${dropped} lower-priority item(s) omitted — rows are ordered stuck, blocked, buildable, waiting]`,
  ]
    .filter((part) => part !== "")
    .join("\n");

  return withNext(body, [
    "{build} to inspect a running build",
    "{abort} to cancel a running build",
  ]);
}

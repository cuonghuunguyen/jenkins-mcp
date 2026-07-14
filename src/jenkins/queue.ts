/**
 * Bounded queue-item -> build-number resolution helper (CTRL-03 resolution
 * half, D-04/D-04a).
 *
 * `jenkins_trigger_build` (src/tools/trigger.ts) POSTs a build trigger and
 * gets back a Location header naming a `/queue/item/<id>/` — that id is
 * NOT a build number (Pitfall 1). This module polls the queue item's
 * `api/json` until Jenkins assigns it a real `executable.number`, a
 * cancellation, or a bounded timeout elapses. It always returns — never an
 * unbounded loop (D-04a) — and it resolves the queue item to a build number
 * ONLY; it deliberately does not grow into a build-completion monitor
 * (Pitfall 2, D-03 — that's agent-driven via jenkins_bash).
 *
 * Each iteration's fetch-and-check step mirrors the exact
 * `client.get()` -> `if (!res.ok) throw normalizeError(...)` -> parse shape
 * used throughout `vfs.ts`'s lazy providers (e.g. `registerJobApiJson`).
 */

import type { JenkinsClient } from "./client.js";
import { normalizeError } from "./errors.js";

/** Shape of a Jenkins `/queue/item/<id>/api/json` response body. */
export interface QueueItemBody {
  executable?: { number: number; url: string };
  cancelled?: boolean;
  blocked?: boolean;
  stuck?: boolean;
  why?: string | null;
}

/** Result of a successful queue-item resolution to a real build number. */
export interface QueueResolved {
  resolved: true;
  buildNumber: number;
  url: string;
}

/** Result when the queue item did not resolve within the bound (or was cancelled). */
export interface QueueUnresolved {
  resolved: false;
  why: string | null;
  cancelled: boolean;
}

export type QueuePollResult = QueueResolved | QueueUnresolved;

/** Initial backoff delay between polls, in milliseconds. */
const INITIAL_DELAY_MS = 500;
/** Backoff multiplier applied after each poll. */
const BACKOFF_MULTIPLIER = 1.5;
/** Maximum backoff delay between polls, in milliseconds. */
const MAX_DELAY_MS = 3000;

/**
 * Polls `/queue/item/<queueId>/api/json` until Jenkins assigns an
 * `executable.number` (resolved), reports `cancelled` (unresolved), or
 * `timeoutMs` elapses since the call began (unresolved) — whichever comes
 * first. Backs off exponentially between polls (starting at 500ms, capped
 * at 3000ms) rather than a tight loop (Pitfall 5).
 *
 * Throws the normalized `JenkinsError` from `normalizeError(res, ...)` if
 * any poll's response is non-ok (e.g. a 500) — the same redaction choke
 * point every other Jenkins call in this codebase routes through.
 */
export async function pollQueueItem(
  client: JenkinsClient,
  queueId: string,
  timeoutMs: number,
): Promise<QueuePollResult> {
  const start = Date.now();
  let delayMs = INITIAL_DELAY_MS;

  for (;;) {
    const res = await client.get(`/queue/item/${queueId}/api/json`);
    if (!res.ok) throw normalizeError(res, "jenkins_trigger_build:queue-poll");
    const body = (await res.json()) as QueueItemBody;

    if (body.executable?.number !== undefined) {
      return { resolved: true, buildNumber: body.executable.number, url: body.executable.url };
    }
    if (body.cancelled) {
      return { resolved: false, why: body.why ?? "Queue item was cancelled", cancelled: true };
    }
    if (Date.now() - start >= timeoutMs) {
      return { resolved: false, why: body.why ?? null, cancelled: false };
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
  }
}

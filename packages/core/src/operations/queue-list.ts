/**
 * Instance-wide queue listing (READ-12).
 *
 * Distinct from `operations/queue.ts`, which polls ONE queue item to a build
 * number for `trigger`. This lists everything Jenkins is currently holding,
 * which is what an operator asks when a build "did not start".
 *
 * One request, 10s cache: the queue is the fastest-moving state on an
 * instance, so anything longer answers a question about the past.
 */

import type { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";

/** Cache key for the whole listing - one entry, refreshed as a unit. */
const QUEUE_CACHE_KEY = "queue:list";

/** Fields fetched per queue item. */
const QUEUE_TREE =
  "items[id,why,blocked,buildable,stuck,inQueueSince," +
  "task[name,fullName,url],actions[parameters[name,value]]]";

/** Wire shape of `/queue/api/json` under QUEUE_TREE. */
interface ApiQueueResponse {
  items?: ApiQueueItem[];
}

interface ApiQueueItem {
  id?: number;
  why?: string | null;
  blocked?: boolean;
  buildable?: boolean;
  stuck?: boolean;
  inQueueSince?: number;
  task?: { name?: string; fullName?: string; url?: string };
  actions?: Array<{ parameters?: Array<{ name?: string; value?: unknown }> }>;
}

/**
 * Derived, not copied: Jenkins sets several of these flags at once (a stuck
 * item is also buildable), so a single actionable state is picked by priority.
 */
export type QueueItemState = "stuck" | "blocked" | "buildable" | "waiting";

export interface QueuedItem {
  id: number;
  /**
   * Absent when the caller cannot read the queued job: Jenkins then returns a
   * task without a name rather than hiding the item, so this stays optional
   * instead of throwing.
   */
  jobFullName?: string;
  /** Jenkins' human reason string; null when it has none to give. */
  why: string | null;
  state: QueueItemState;
  /** Milliseconds the item has been queued; absent when `inQueueSince` is not reported. */
  waitingFor?: number;
  params: Array<{ name: string; value: string }>;
}

export interface QueueListing {
  items: QueuedItem[];
  total: number;
}

function stateOf(item: ApiQueueItem): QueueItemState {
  if (item.stuck === true) return "stuck";
  if (item.blocked === true) return "blocked";
  if (item.buildable === true) return "buildable";
  return "waiting";
}

function paramsOf(item: ApiQueueItem): Array<{ name: string; value: string }> {
  return (item.actions ?? []).flatMap((action) =>
    (action.parameters ?? [])
      .filter((param): param is { name: string; value?: unknown } => typeof param.name === "string")
      .map((param) => ({ name: param.name, value: String(param.value ?? "") })),
  );
}

function normalizeItem(item: ApiQueueItem, now: number): QueuedItem {
  return {
    id: item.id ?? -1,
    jobFullName: item.task?.fullName ?? item.task?.name,
    why: item.why ?? null,
    state: stateOf(item),
    waitingFor: item.inQueueSince === undefined ? undefined : now - item.inQueueSince,
    params: paramsOf(item),
  };
}

/** Lists everything currently in the Jenkins build queue. */
export async function listQueue(client: JenkinsClient, cache: JenkinsCache): Promise<QueueListing> {
  return cache.fetch(
    QUEUE_CACHE_KEY,
    async () => {
      const res = await client.get(`/queue/api/json?tree=${QUEUE_TREE}`);
      if (!res.ok) throw normalizeError(res, "jenkins_queue");
      const body = (await res.json()) as ApiQueueResponse;

      const now = Date.now();
      const items = (body.items ?? []).map((item) => normalizeItem(item, now));
      return { items, total: items.length };
    },
    "volatile",
  );
}

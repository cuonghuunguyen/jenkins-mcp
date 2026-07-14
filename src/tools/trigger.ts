/**
 * jenkins_trigger_build MCP tool adapter (CTRL-01/CTRL-02, CTRL-03
 * resolution half, D-01/D-04/D-04a/D-04b/D-05).
 *
 * POSTs a build trigger — `/build` when no params are given, or
 * `/buildWithParameters` (D-05 pass-through, no client-side validation)
 * when a non-empty params map is given — then extracts the queue item id
 * from the response's `Location` header and resolves it to a real build
 * number via the bounded `pollQueueItem` helper (queue.ts, D-04a). The
 * result is a two-branch discriminated union (D-04b) that makes returning
 * the raw Location-header queue id as a build number impossible at the
 * type level (Pitfall 1): a resolved branch with `buildNumber`, or an
 * unresolved `queued` branch that never has a `buildNumber` field.
 *
 * Reuses only the existing `JenkinsClient`, `jobPath`/`parsePathString`,
 * `normalizeError`, and `pollQueueItem` — no second HTTP client, no second
 * path resolver, no client-side parameter validation, and no
 * confirmation/dry-run gate (D-09, agent is trusted).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JenkinsClient } from "../jenkins/client.js";
import { JenkinsError, normalizeError } from "../jenkins/errors.js";
import { jobPath, parsePathString } from "../jenkins/paths.js";
import { pollQueueItem } from "../jenkins/queue.js";

/** MCP tool name (D-01, jenkins_<verb> convention). */
export const TRIGGER_TOOL_NAME = "jenkins_trigger_build";

/** Human-readable description surfaced to the MCP client (MCP-02). */
export const TRIGGER_TOOL_DESCRIPTION =
  "Trigger a Jenkins build for a freestyle or pipeline job, optionally with " +
  "build parameters. Waits a short bounded time (default 15s, override with " +
  "`timeout` in seconds) for Jenkins to assign the queued request a real " +
  "build number. If it resolves in time, returns the build number to watch; " +
  "otherwise returns the queue id and reason it hasn't started yet. Either " +
  "way, use jenkins_bash to monitor the build (cat builds/<n>/api.json, " +
  "tail builds/<n>/log) or the queue (cat queue.json) afterwards.";

/**
 * Zod raw shape (matches `whoamiInputSchema`'s bare-object convention, NOT
 * a wrapped `z.object()`).
 */
export const triggerInputSchema = {
  path: z.string(),
  params: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
};

/** Arguments accepted by `triggerBuild`/`createTriggerHandler`. */
export interface TriggerArgs {
  path: string;
  params?: Record<string, string>;
  timeout?: number;
}

/** Default bound (in seconds) on the internal queue-resolution poll (D-04a). */
export const DEFAULT_RESOLVE_TIMEOUT_S = 15;

/** Result when the queue item resolved to a real build number within the bound. */
export interface TriggerResolved {
  buildNumber: number;
  building: boolean;
  url: string;
  hint: string;
}

/** Result when the bounded wait elapsed before the queue item resolved. */
export interface TriggerQueued {
  queued: true;
  queueId: string;
  why: string | null;
  hint: string;
}

/**
 * Discriminated union (D-04b) — the two branches make it impossible at the
 * type level for the raw Location-header queue id to be returned as
 * `buildNumber` (Pitfall 1).
 */
export type TriggerResult = TriggerResolved | TriggerQueued;

const QUEUE_ITEM_LOCATION_RE = /\/queue\/item\/(\d+)\/?$/;

/**
 * Extracts the numeric queue item id from a trigger POST's `Location`
 * header. Throws a `JenkinsError` — never fabricates an id — when the
 * header is missing or does not match the expected `/queue/item/<id>/`
 * shape.
 */
export function extractQueueId(location: string | null): string {
  const match = location ? QUEUE_ITEM_LOCATION_RE.exec(location) : null;
  if (!match) {
    throw new JenkinsError(
      "Jenkins did not return a usable queue item Location header after the " +
        "trigger POST - cannot resolve a build number.",
      TRIGGER_TOOL_NAME,
    );
  }
  return match[1];
}

/**
 * Issues the trigger POST (endpoint chosen by params presence), extracts
 * the queue item id from the Location header, and resolves it to a real
 * build number via the bounded `pollQueueItem` helper. Throws
 * `normalizeError(res, TRIGGER_TOOL_NAME)` on a non-ok POST response.
 */
export async function triggerBuild(
  client: JenkinsClient,
  args: TriggerArgs,
): Promise<TriggerResult> {
  const restPath = `/job/${jobPath(parsePathString(args.path))}`;
  const hasParams = args.params !== undefined && Object.keys(args.params).length > 0;

  const res = hasParams
    ? await client.post(`${restPath}/buildWithParameters`, {
        body: new URLSearchParams(args.params),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
    : await client.post(`${restPath}/build`, undefined);

  if (!res.ok) throw normalizeError(res, TRIGGER_TOOL_NAME);

  const queueId = extractQueueId(res.headers.get("Location"));
  const timeoutMs = (args.timeout ?? DEFAULT_RESOLVE_TIMEOUT_S) * 1000;
  const outcome = await pollQueueItem(client, queueId, timeoutMs);

  if (outcome.resolved) {
    return {
      buildNumber: outcome.buildNumber,
      building: true,
      url: outcome.url,
      hint:
        `Build ${outcome.buildNumber} started - use jenkins_bash to monitor it ` +
        `(cat builds/${outcome.buildNumber}/api.json, tail builds/${outcome.buildNumber}/log).`,
    };
  }

  return {
    queued: true,
    queueId,
    why: outcome.why,
    hint: "Still queued - use jenkins_bash to check the queue (cat queue.json).",
  };
}

/**
 * Builds the `registerTool` handler bound to a given `JenkinsClient`
 * instance (mirrors `createWhoamiHandler`'s shape).
 */
export function createTriggerHandler(
  client: JenkinsClient,
): (args: TriggerArgs) => Promise<CallToolResult> {
  return async (args) => {
    const result = await triggerBuild(client, args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  };
}

/**
 * jenkins_abort_build MCP tool adapter (CTRL-04, D-06).
 *
 * Gracefully aborts a running build by issuing a single crumb-protected
 * POST to `/job/<path>/<buildNumber>/stop` — the same behavior as clicking
 * the Jenkins Abort button. Per RESEARCH.md Assumption A1, both a 2xx AND a
 * 302 response are treated as success (Jenkins' `/stop` endpoint commonly
 * redirects back to the build page on success). Any other status routes
 * through `normalizeError` so the surfaced message is redacted/actionable
 * and never leaks a token/crumb/cookie value (CONN-03).
 *
 * The write boundary intentionally stays at `/stop` only (SAFE-02) - this
 * tool never constructs the forceful `/term` or `/kill` escalation
 * endpoints, which are out of v1 scope.
 *
 * Reuses only the existing `JenkinsClient`, `jobPath`/`parsePathString`,
 * and `normalizeError` - no second HTTP client, no second path resolver,
 * and no confirmation/dry-run gate (D-09, agent is trusted).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JenkinsClient } from "../jenkins/client.js";
import { normalizeError } from "../jenkins/errors.js";
import { jobPath, parsePathString } from "../jenkins/paths.js";

/** MCP tool name (D-01, jenkins_<verb> convention). */
export const ABORT_TOOL_NAME = "jenkins_abort_build";

/** Human-readable description surfaced to the MCP client (MCP-02). */
export const ABORT_TOOL_DESCRIPTION =
  "Gracefully abort a running Jenkins build - the same effect as clicking " +
  "the Abort button in the Jenkins UI. Takes the job path and the build " +
  "number to abort.";

/**
 * Zod raw shape (matches `whoamiInputSchema`'s bare-object convention, NOT
 * a wrapped `z.object()`). Two separate fields per RESEARCH.md Open
 * Question 2 recommendation.
 */
export const abortInputSchema = {
  path: z.string(),
  buildNumber: z.number(),
};

/** Arguments accepted by `abortBuild`/`createAbortHandler`. */
export interface AbortArgs {
  path: string;
  buildNumber: number;
}

/**
 * Issues a single POST to `/job/<path>/<buildNumber>/stop`. A 2xx or a 302
 * response is treated as success (Assumption A1). Any other status throws
 * `normalizeError(res, ABORT_TOOL_NAME)` - never a second endpoint, never
 * a raw Response interpolated into a message (CONN-03).
 */
export async function abortBuild(client: JenkinsClient, args: AbortArgs): Promise<void> {
  const restPath = `/job/${jobPath(parsePathString(args.path))}/${args.buildNumber}/stop`;
  const res = await client.post(restPath);
  if (!res.ok && res.status !== 302) throw normalizeError(res, ABORT_TOOL_NAME);
}

/**
 * Builds the `registerTool` handler bound to a given `JenkinsClient`
 * instance (mirrors `createWhoamiHandler`'s shape).
 */
export function createAbortHandler(
  client: JenkinsClient,
): (args: AbortArgs) => Promise<CallToolResult> {
  return async (args) => {
    await abortBuild(client, args);
    return {
      content: [
        {
          type: "text",
          text: `Abort requested for ${args.path} build #${args.buildNumber}.`,
        },
      ],
    };
  };
}

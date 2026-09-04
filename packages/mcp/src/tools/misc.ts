/**
 * Queue listing and the raw-GET escape hatch (READ-12).
 *
 * Two unrelated capabilities in one file because both are single-tool
 * adapters with nothing to share with the typed read tools. Every handler is
 * still the one-liner: format(await operation(...)).
 */

import {
  apiGet,
  formatApiGetResult,
  formatQueueListing,
  type JenkinsCache,
  type JenkinsClient,
  listQueue,
} from "@cuonghuunguyen/jenkins-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool } from "./result.js";

export function registerMiscTools(
  server: McpServer,
  client: JenkinsClient,
  cache: JenkinsCache,
): string[] {
  // -------------------------------------------------------------------------
  // jenkins_queue (READ-12)
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_queue",
    {
      description:
        "List everything currently waiting in the Jenkins build queue, with the derived " +
        "state of each item (stuck, blocked, buildable, waiting), how long it has been " +
        "queued, and Jenkins' own reason string. Use this when a triggered build has not " +
        "started. Instance-wide - takes no job.",
      inputSchema: {},
    },
    async () =>
      runTool("jenkins_queue", async () => formatQueueListing(await listQueue(client, cache))),
  );

  // -------------------------------------------------------------------------
  // jenkins_api_get (READ-12)
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_api_get",
    {
      description:
        "GET any path on the connected Jenkins instance and return the raw response " +
        "text. The escape hatch for endpoints the typed tools do not cover (config.xml, " +
        "plugin endpoints). Read-only: it can never write. Prefer a typed tool when one " +
        "exists - this returns unprojected data and spends context.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Path on the configured Jenkins instance, starting with '/', e.g. " +
              "'/job/team-a/job/svc/config.xml'. An absolute URL, a protocol-relative " +
              "'//host' path, a '..' segment, or an embedded query string is rejected - " +
              "pass any projection via 'tree' instead.",
          ),
        tree: z
          .string()
          .optional()
          .describe(
            "Jenkins tree= field projection, e.g. 'jobs[fullName,color]'. REQUIRED when " +
              "path ends with 'api/json': an unprojected api/json returns megabytes.",
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Body budget in bytes (default 65536). Raise it to receive the rest of a " +
              "body that was truncated - tree= cannot narrow a non-api/json path such " +
              "as config.xml, so this is the only route to the remainder.",
          ),
      },
    },
    async ({ path, tree, max_bytes }: { path: string; tree?: string; max_bytes?: number }) =>
      runTool("jenkins_api_get", async () =>
        formatApiGetResult(await apiGet(client, { path, tree, maxBytes: max_bytes })),
      ),
  );

  return ["jenkins_queue", "jenkins_api_get"];
}

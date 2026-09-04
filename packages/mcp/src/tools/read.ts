/**
 * Read-only tool adapters. Every handler is the same one-liner:
 * `runTool(name, () => format(await operation(client, cache, params)))`.
 *
 * No logic lives here. If a handler needs a branch, that branch belongs in a
 * core operation where the CLI gets it too (ARCH-03).
 */

import {
  findJobs,
  formatJobSearch,
  formatWhoAmI,
  type JenkinsCache,
  type JenkinsClient,
  whoami,
} from "@cuonghuunguyen/jenkins-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool } from "./result.js";
import { limitSchema } from "./schemas.js";

export function registerReadTools(
  server: McpServer,
  client: JenkinsClient,
  cache: JenkinsCache,
  indexDepth: number,
): string[] {
  // -------------------------------------------------------------------------
  // jenkins_whoami (D-05)
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_whoami",
    {
      description:
        "Return the identity the server is authenticated as against the connected " +
        "Jenkins instance. Use this to confirm connectivity and that the configured " +
        "credentials resolve to the expected account.",
      inputSchema: {},
    },
    async () => runTool("jenkins_whoami", async () => formatWhoAmI(await whoami(client))),
  );

  // -------------------------------------------------------------------------
  // jenkins_find_jobs (READ-07)
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_find_jobs",
    {
      description:
        "Find jobs on the connected Jenkins instance by fullName substring or by git " +
        "remote URL. Pass the output of `git remote get-url origin` to find the job " +
        "that builds the current checkout. Omit the query to browse. Reads a cached, " +
        "single-request index covering folders, multibranch branches, PRs and tags.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("fullName substring, or a git remote URL. Omit to list the index."),
        limit: limitSchema,
      },
    },
    async ({ query, limit }: { query?: string; limit?: number }) =>
      runTool("jenkins_find_jobs", async () =>
        formatJobSearch(await findJobs(client, cache, { query, limit, depth: indexDepth })),
      ),
  );

  return ["jenkins_whoami", "jenkins_find_jobs"];
}

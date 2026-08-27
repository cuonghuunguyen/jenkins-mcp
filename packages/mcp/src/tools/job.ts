/**
 * `jenkins_job` adapter (READ-08, REF-02).
 *
 * One-liner handler: no logic here, no branch on the container-vs-job shape -
 * that discrimination lives in the core operation so the CLI gets it too
 * (ARCH-03).
 */

import {
  formatJobDetail,
  getJobDetail,
  type JenkinsCache,
  type JenkinsClient,
} from "@jenkins-mcp/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "./result.js";
import { jobSchema, refSchema } from "./schemas.js";

export function registerJobTools(
  server: McpServer,
  client: JenkinsClient,
  cache: JenkinsCache,
  indexDepth: number,
): string[] {
  server.registerTool(
    "jenkins_job",
    {
      description:
        "Inspect one Jenkins job: its build parameters and its last 10 builds. " +
        "Called on a multibranch parent or a folder (no ref), it lists that " +
        "container's children instead - branches, PR-<n> and tags with their last " +
        "result - so you can pick a ref. Pass ref to address one branch, tag or PR; " +
        "a bare number means a PR ('42' is 'PR-42').",
      inputSchema: { job: jobSchema, ref: refSchema },
    },
    async ({ job, ref }: { job: string; ref?: string }) =>
      runTool("jenkins_job", async () =>
        formatJobDetail(await getJobDetail(client, cache, { job, ref, depth: indexDepth })),
      ),
  );

  return ["jenkins_job"];
}

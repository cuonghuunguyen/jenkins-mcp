/**
 * `jenkins_build` adapter (READ-09).
 *
 * One-liner handler: the operation reads, the core formatter renders, this
 * file only declares the input shape (ARCH-03).
 */

import {
  formatBuildDetail,
  getBuildDetail,
  type JenkinsCache,
  type JenkinsClient,
} from "@cuonghuunguyen/jenkins-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "./result.js";
import { buildSchema, jobSchema, refSchema } from "./schemas.js";

export function registerBuildTools(
  server: McpServer,
  client: JenkinsClient,
  cache: JenkinsCache,
  indexDepth: number,
): string[] {
  server.registerTool(
    "jenkins_build",
    {
      description:
        "Inspect one Jenkins build in a single call: status, build cause, parameters, " +
        "changeset commits, pipeline stages, failed steps and failed tests. `build` " +
        "defaults to the last build; it also accepts a build number, -1, or a permalink " +
        "alias such as lastFailedBuild. Stage and test data are omitted explicitly when " +
        "the build is not a pipeline or published no test report.",
      inputSchema: {
        job: jobSchema,
        ref: refSchema,
        build: buildSchema,
      },
    },
    async ({ job, ref, build }: { job: string; ref?: string; build?: string | number }) =>
      runTool("jenkins_build", async () =>
        formatBuildDetail(
          await getBuildDetail(client, cache, { job, ref, build, depth: indexDepth }),
        ),
      ),
  );

  return ["jenkins_build"];
}

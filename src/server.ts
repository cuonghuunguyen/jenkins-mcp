/**
 * `createServer(config)` — MCP server factory (MCP-01/MCP-02).
 *
 * Constructs the `McpServer` (imported from the v1.x SDK path
 * `@modelcontextprotocol/sdk/server/mcp.js` — NOT the v2 beta
 * `@modelcontextprotocol/server` package, per RESEARCH.md "State of the
 * Art"), builds the one `JenkinsClient` the whole process shares, and
 * registers `jenkins_whoami` and `jenkins_bash` with their zod input
 * schemas and human-readable descriptions (MCP-02, D-05, D-01/D-02).
 * Called once from `index.ts` after config has already been validated
 * (D-02) — this module performs no config loading or transport wiring of
 * its own. Both tools share the single `JenkinsClient` constructed here —
 * no second client is ever created (D-02).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createJenkinsClient } from "./jenkins/client.js";
import {
  BASH_TOOL_DESCRIPTION,
  BASH_TOOL_NAME,
  bashInputSchema,
  createBashHandler,
} from "./tools/bash.js";
import {
  createWhoamiHandler,
  WHOAMI_TOOL_DESCRIPTION,
  WHOAMI_TOOL_NAME,
  whoamiInputSchema,
} from "./tools/whoami.js";

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "jenkins-mcp", version: "0.1.0" });
  const client = createJenkinsClient(config);

  server.registerTool(
    WHOAMI_TOOL_NAME,
    {
      description: WHOAMI_TOOL_DESCRIPTION,
      inputSchema: whoamiInputSchema,
    },
    createWhoamiHandler(client),
  );

  server.registerTool(
    BASH_TOOL_NAME,
    {
      description: BASH_TOOL_DESCRIPTION,
      inputSchema: bashInputSchema,
    },
    createBashHandler(client),
  );

  return server;
}

/**
 * `createServer(config)` — MCP server factory (MCP-01/MCP-02).
 *
 * Constructs the `McpServer` (imported from the v1.x SDK path
 * `@modelcontextprotocol/sdk/server/mcp.js` — NOT the v2 beta
 * `@modelcontextprotocol/server` package, per RESEARCH.md "State of the
 * Art"), builds the one `JenkinsClient` the whole process shares, and
 * registers the full v1 tool set — `jenkins_whoami`, `jenkins_bash`,
 * `jenkins_trigger_build`, `jenkins_abort_build`, `jenkins_diagnose_build` —
 * with their zod input schemas and human-readable descriptions (MCP-02,
 * D-05, D-01/D-02). Called once from `index.ts` after config has already
 * been validated (D-02) — this module performs no config loading or
 * transport wiring of its own. All five tools share the single
 * `JenkinsClient` constructed here — no second client is ever created
 * (D-01/D-02). `jenkins_diagnose_build` is read-only (Phase 4 D-01/D-02) —
 * it issues only `client.get()` calls and adds no write surface.
 *
 * Registration goes through a single `REGISTERED_TOOLS` array so the
 * exported `TOOL_NAMES` list is derived from the exact registration path
 * and cannot drift from what is actually registered (D-08, criterion 5) —
 * this is the durable structural guard that no create/update/delete tool
 * has been added (SAFE-01) and that the tool surface is exactly these
 * five (SAFE-02).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { createJenkinsClient, type JenkinsClient } from "./jenkins/client.js";
import {
  ABORT_TOOL_DESCRIPTION,
  ABORT_TOOL_NAME,
  abortInputSchema,
  createAbortHandler,
} from "./tools/abort.js";
import {
  BASH_TOOL_DESCRIPTION,
  BASH_TOOL_NAME,
  bashInputSchema,
  createBashHandler,
} from "./tools/bash.js";
import {
  createDiagnoseHandler,
  DIAGNOSE_TOOL_DESCRIPTION,
  DIAGNOSE_TOOL_NAME,
  diagnoseInputSchema,
} from "./tools/diagnose.js";
import {
  createTriggerHandler,
  TRIGGER_TOOL_DESCRIPTION,
  TRIGGER_TOOL_NAME,
  triggerInputSchema,
} from "./tools/trigger.js";
import {
  createWhoamiHandler,
  WHOAMI_TOOL_DESCRIPTION,
  WHOAMI_TOOL_NAME,
  whoamiInputSchema,
} from "./tools/whoami.js";

/** A single registrable tool entry — the one source of truth for the tool set. */
interface RegisteredTool {
  name: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: zod raw-shape schemas vary per tool; registerTool accepts any shape.
  inputSchema: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: handler arg shape varies per tool; registerTool accepts any shape.
  handler: (args: any) => Promise<CallToolResult>;
}

/**
 * Builds the ordered registry of every tool this server exposes, bound to
 * the given shared `JenkinsClient`. Both `server.registerTool` calls and
 * the exported `TOOL_NAMES` list are derived from this same array, so the
 * two can never drift apart (D-08, criterion 5).
 */
function buildRegisteredTools(client: JenkinsClient): RegisteredTool[] {
  return [
    {
      name: WHOAMI_TOOL_NAME,
      description: WHOAMI_TOOL_DESCRIPTION,
      inputSchema: whoamiInputSchema,
      handler: createWhoamiHandler(client),
    },
    {
      name: BASH_TOOL_NAME,
      description: BASH_TOOL_DESCRIPTION,
      inputSchema: bashInputSchema,
      handler: createBashHandler(client),
    },
    {
      name: TRIGGER_TOOL_NAME,
      description: TRIGGER_TOOL_DESCRIPTION,
      inputSchema: triggerInputSchema,
      handler: createTriggerHandler(client),
    },
    {
      name: ABORT_TOOL_NAME,
      description: ABORT_TOOL_DESCRIPTION,
      inputSchema: abortInputSchema,
      handler: createAbortHandler(client),
    },
    {
      name: DIAGNOSE_TOOL_NAME,
      description: DIAGNOSE_TOOL_DESCRIPTION,
      inputSchema: diagnoseInputSchema,
      handler: createDiagnoseHandler(client),
    },
  ];
}

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "jenkins-mcp", version: "0.1.0" });
  const client = createJenkinsClient(config);

  for (const tool of buildRegisteredTools(client)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler,
    );
  }

  return server;
}

/**
 * The exact set of tool names this server registers, derived from the same
 * `buildRegisteredTools` array used at registration time — cannot drift
 * from what is actually registered (D-08, criterion 5). A dummy client
 * shape is sufficient here since only `.name` is read from each entry; no
 * handler is invoked.
 */
export const TOOL_NAMES: readonly string[] = buildRegisteredTools({} as JenkinsClient).map(
  (t) => t.name,
);

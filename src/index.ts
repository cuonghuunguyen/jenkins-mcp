#!/usr/bin/env node
/**
 * Process entrypoint (MCP-01/D-02).
 *
 * Boot order matters: `loadConfig()` runs first and exits non-zero on
 * missing/malformed config (D-02) BEFORE the server or Jenkins client are
 * constructed — the server must never start with invalid config. Only
 * after that does `createServer()` build the `McpServer` + `JenkinsClient`,
 * and only then does `server.connect()` attach the stdio transport. From
 * that point on, stdout is reserved exclusively for JSON-RPC frames; all
 * diagnostic output goes through the stderr-only `logger` module, never
 * `console.log`/`process.stdout.write` (MCP-01).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env); // fail-fast, exits non-zero on bad config (D-02)
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  logger.info("jenkins-mcp server connected over stdio");
}

main().catch((err) => {
  logger.error("jenkins-mcp server failed to start", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

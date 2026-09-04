/**
 * MCP server factory.
 *
 * Builds one client and one cache for the whole process and hands both to
 * every tool registrar, so the volatility-tiered cache is genuinely
 * process-wide (AGNT-01) rather than per-call as the deleted VFS was.
 *
 * `TOOL_NAMES` is derived from the registrars themselves rather than being a
 * hand-maintained list, so it cannot drift from what is actually registered -
 * which is what makes the structural safety test meaningful.
 *
 * Under `config.readonly` (SAFE-03) the control registrar is called with the
 * flag and simply never registers the two write tools, so the read-only tool
 * list is produced by the same code path the real server runs.
 */

import {
  type Config,
  createJenkinsClient,
  JenkinsCache,
  type JenkinsClient,
} from "@cuonghuunguyen/jenkins-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBuildTools } from "./tools/build.js";
import { registerControlTools } from "./tools/control.js";
import { registerJobTools } from "./tools/job.js";
import { registerLogTools } from "./tools/log.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerReadTools } from "./tools/read.js";

export const SERVER_NAME = "jenkins-mcp";
export const SERVER_VERSION = "0.2.0";

export interface CreatedServer {
  server: McpServer;
  toolNames: string[];
}

export function createServer(config: Config): CreatedServer {
  const client: JenkinsClient = createJenkinsClient(config);
  const cache = new JenkinsCache();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const toolNames = [
    ...registerReadTools(server, client, cache, config.indexDepth),
    ...registerJobTools(server, client, cache, config.indexDepth),
    ...registerBuildTools(server, client, cache, config.indexDepth),
    ...registerLogTools(server, client, cache, config.indexDepth),
    ...registerMiscTools(server, client, cache),
    ...registerControlTools(server, client, cache, config.indexDepth, config.readonly),
  ];

  return { server, toolNames };
}

/**
 * The tool names this server registers, for the structural safety test.
 *
 * Registration is driven against a throwaway `McpServer` and a fake client:
 * the handlers are never invoked, so no connection is made, but the list comes
 * from the same code path the real server uses. `readonly` is a parameter so
 * the test can assert BOTH modes (SAFE-03).
 */
export function toolNames(readonly = false): string[] {
  const probe = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const client = {} as JenkinsClient;
  const cache = new JenkinsCache();
  return [
    ...registerReadTools(probe, client, cache, 6),
    ...registerJobTools(probe, client, cache, 6),
    ...registerBuildTools(probe, client, cache, 6),
    ...registerLogTools(probe, client, cache, 6),
    ...registerMiscTools(probe, client, cache),
    ...registerControlTools(probe, client, cache, 6, readonly),
  ];
}

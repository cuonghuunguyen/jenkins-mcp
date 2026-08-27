#!/usr/bin/env node
/**
 * jenkins-mcp entrypoint.
 *
 * Ordering is load-bearing: config is validated (and the process exits on a
 * bad one) BEFORE a server is built or a transport attached, so a
 * misconfigured server never opens a transport and then fails mid-session.
 *
 * stdout belongs to the JSON-RPC transport in stdio mode. Every log line goes
 * to stderr, and biome's `noConsole` rule (which allows only `console.error`)
 * enforces that mechanically rather than by review.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { loadConfig, logger } from "@jenkins-mcp/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

/** Reads a request body to completion and parses it as JSON. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? undefined : JSON.parse(raw);
}

async function startStdio(): Promise<void> {
  const config = loadConfig(process.env);
  const { server, toolNames } = createServer(config);
  await server.connect(new StdioServerTransport());
  logger.info("jenkins-mcp connected over stdio", { tools: toolNames.length });
}

/**
 * HTTP mode, one MCP session per `mcp-session-id`. Each session gets its own
 * server instance (and therefore its own cache), which is what keeps two
 * clients from sharing invalidation state.
 */
async function startHttp(port: number): Promise<void> {
  const config = loadConfig(process.env);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const http = createHttpServer((req, res) => {
    void (async () => {
      try {
        const sessionId = req.headers["mcp-session-id"];
        const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

        if (existing !== undefined) {
          await existing.handleRequest(req, res, await readJsonBody(req));
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(400).end("Missing or unknown mcp-session-id");
          return;
        }

        // Annotated explicitly because the config closure references the
        // transport it is initializing, which tsc cannot infer through.
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string): void => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
        };

        const { server } = createServer(config);
        await server.connect(transport);
        await transport.handleRequest(req, res, await readJsonBody(req));
      } catch (err) {
        logger.error("jenkins-mcp http request failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) res.writeHead(500).end("Internal error");
      }
    })();
  });

  http.listen(port, () => {
    logger.info("jenkins-mcp listening for streamable HTTP", { port });
  });
}

const portArg = process.env.MCP_HTTP_PORT;
const httpPort =
  portArg !== undefined && portArg !== ""
    ? Number.parseInt(portArg, 10)
    : process.argv.includes("--http")
      ? 3000
      : undefined;

const main = httpPort !== undefined ? startHttp(httpPort) : startStdio();

main.catch((err: unknown) => {
  logger.error("jenkins-mcp failed to start", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

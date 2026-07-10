/**
 * Stdout-purity integration test (MCP-01 proof).
 *
 * Spawns the compiled server (`node dist/index.js` — depends on `npm run
 * build` having produced `dist/index.js`) as a real child process with a
 * fake Jenkins env (config passes zod validation, but no live Jenkins is
 * ever contacted since this test never issues a `jenkins_whoami` tool
 * call). Sends a minimal JSON-RPC `initialize` request on stdin and
 * asserts every non-empty line on stdout parses as well-formed JSON-RPC —
 * i.e. no stray non-protocol bytes ever reach stdout (RESEARCH.md "Code
 * Examples > Stdout-Purity Integration Test").
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const FAKE_ENV = {
  ...process.env,
  JENKINS_URL: "http://fake-jenkins.invalid",
  JENKINS_USER: "fake-user",
  JENKINS_API_TOKEN: "fake-token",
};

describe("stdio hygiene (MCP-01)", () => {
  it("emits only well-formed JSON-RPC frames on stdout; diagnostics stay on stderr", async () => {
    const child: ChildProcessWithoutNullStreams = spawn("node", ["dist/index.js"], {
      env: FAKE_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));

    try {
      const initializeRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "stdio-hygiene-test", version: "0.1.0" },
        },
      };
      child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);

      // Give the server time to respond, then send the "initialized" notification.
      await delay(500);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      await delay(300);

      const stdoutText = stdoutChunks.join("");
      const stdoutLines = stdoutText.split("\n").filter((line) => line.trim().length > 0);

      // At least one frame (the initialize response) must have reached stdout.
      expect(stdoutLines.length).toBeGreaterThan(0);

      for (const line of stdoutLines) {
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(line);
        }).not.toThrow();
        expect((parsed as { jsonrpc?: string }).jsonrpc).toBe("2.0");
      }

      // Boot diagnostics (if any) must never land on stdout.
      expect(stdoutText).not.toContain("jenkins-mcp server connected");
    } finally {
      child.kill();
    }
  }, 10000);
});

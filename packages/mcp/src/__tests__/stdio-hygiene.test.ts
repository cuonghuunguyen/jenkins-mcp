/**
 * Stdout-purity integration test (MCP-01 proof).
 *
 * Spawns the compiled server as a real child process with a fake Jenkins env
 * (config passes validation, but no live Jenkins is contacted because no tool
 * call is ever issued), sends a minimal JSON-RPC `initialize` request on
 * stdin, and asserts every non-empty stdout line parses as well-formed
 * JSON-RPC - i.e. no stray non-protocol bytes reach stdout.
 *
 * Depends on `dist/index.js` existing, which turbo guarantees by ordering
 * `test` after `build`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Waits until `predicate` holds or the deadline passes, polling cheaply.
 *
 * A fixed sleep was the original approach and it silently became flaky as the
 * server grew: module loading pushed the `initialize` reply past a hardcoded
 * 500ms and the test then asserted "no stdout" as a failure. Waiting on the
 * observable event instead of a guessed duration keeps it honest as the tool
 * surface grows.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(25);
}

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

const FAKE_ENV = {
  ...process.env,
  JENKINS_URL: "http://fake-jenkins.invalid",
  JENKINS_USER: "fake-user",
  JENKINS_API_TOKEN: "fake-token",
};

describe("stdio hygiene (MCP-01)", () => {
  it("emits only well-formed JSON-RPC frames on stdout; diagnostics stay on stderr", async () => {
    const child: ChildProcessWithoutNullStreams = spawn("node", [SERVER_ENTRY], {
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
          clientInfo: { name: "stdio-hygiene-test", version: "0.2.0" },
        },
      };
      child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);

      await waitFor(() => stdoutChunks.length > 0);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      await waitFor(() => stderrChunks.join("").includes("connected over stdio"));

      const stdoutText = stdoutChunks.join("");
      const stdoutLines = stdoutText.split("\n").filter((line) => line.trim().length > 0);

      expect(stdoutLines.length).toBeGreaterThan(0);

      for (const line of stdoutLines) {
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(line);
        }).not.toThrow();
        expect((parsed as { jsonrpc?: string }).jsonrpc).toBe("2.0");
      }

      // Boot diagnostics must never land on stdout.
      expect(stdoutText).not.toContain("connected over stdio");
      expect(stderrChunks.join("")).toContain("connected over stdio");
    } finally {
      child.kill();
    }
  }, 15000);
});

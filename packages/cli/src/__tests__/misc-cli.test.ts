/**
 * CLI wiring tests for `jenkins queue` and `jenkins api get` (READ-12).
 *
 * These drive the real yargs registrars end to end, so `--json`, the `--tree`
 * passthrough and the error exit path are all covered. Global `fetch` is
 * stubbed rather than the client, because `createSession` builds a real client
 * from the environment - that is exactly the wiring under test here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs, { type Argv } from "yargs";
import { registerApiCommand } from "../commands/api.js";
import { registerQueueCommand } from "../commands/queue.js";
import type { GlobalArgs } from "../commands/types.js";

const ORIGINAL_ENV = { ...process.env };

/** Sentinel thrown in place of `process.exit(1)`, so `fail()` is observable. */
class Exited extends Error {}

const QUEUE_BODY = JSON.stringify({
  items: [
    {
      id: 4,
      why: "Waiting for next available executor",
      stuck: true,
      inQueueSince: Date.now() - 60_000,
      task: { fullName: "team-a/svc/main" },
    },
  ],
});

function stubFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    // The client asks for a crumb before every request; answering 404 makes
    // CrumbCache return null, which get() tolerates.
    if (url.includes("/crumbIssuer/")) return new Response("no crumb", { status: 404 });
    if (url.includes("/queue/api/json")) {
      return new Response(QUEUE_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("<config/>", {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
  });
}

function parser(): Argv<GlobalArgs> {
  const root = yargs([])
    .option("json", { type: "boolean", default: false })
    .exitProcess(false) as unknown as Argv<GlobalArgs>;
  return registerApiCommand(registerQueueCommand(root));
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

beforeEach(() => {
  process.env.JENKINS_URL = "https://jenkins.example.com";
  process.env.JENKINS_USER = "alice";
  process.env.JENKINS_API_TOKEN = "token";
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Exited();
  }) as never);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("jenkins queue", () => {
  it("prints the queue through the core formatter, with refs resolved to jenkins commands", async () => {
    stubFetch();
    const out = captureStdout();

    await parser().parseAsync(["queue"]);

    expect(out.text()).toContain("queue (1)");
    expect(out.text()).toContain("team-a/svc/main");
    expect(out.text()).toContain("next: jenkins build");
    expect(out.text()).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("prints the operation's raw data under --json", async () => {
    stubFetch();
    const out = captureStdout();

    await parser().parseAsync(["queue", "--json"]);

    expect(JSON.parse(out.text()).items[0].state).toBe("stuck");
  });
});

describe("jenkins api get", () => {
  it("GETs the path and prints the raw body", async () => {
    const fetchSpy = stubFetch();
    const out = captureStdout();

    await parser().parseAsync(["api", "get", "/job/svc/config.xml"]);

    expect(out.text()).toContain("api: /job/svc/config.xml (application/xml");
    expect(out.text()).toContain("<config/>");
    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toBe(
      "https://jenkins.example.com/job/svc/config.xml",
    );
  });

  it("forwards --tree into the request query", async () => {
    const fetchSpy = stubFetch();
    captureStdout();

    await parser().parseAsync(["api", "get", "/api/json", "--tree", "jobs[fullName]"]);

    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("?tree=jobs%5BfullName%5D");
  });

  it("forwards --max-bytes as the body budget", async () => {
    stubFetch();
    const out = captureStdout();

    await parser().parseAsync(["api", "get", "/job/svc/config.xml", "--max-bytes", "4"]);

    expect(out.text()).toContain("[truncated");
  });

  it("rejects a percent-encoded dot-segment escape before any request is made", async () => {
    const fetchSpy = stubFetch();
    const err = captureStderr();

    await expect(parser().parseAsync(["api", "get", "/%2e%2e/%2e%2e/secret"])).rejects.toThrow(
      Exited,
    );

    expect(err.text()).toContain("error: invalid_input");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails with one structured error line when an api/json path has no --tree", async () => {
    stubFetch();
    const err = captureStderr();

    await expect(parser().parseAsync(["api", "get", "/api/json"])).rejects.toThrow(Exited);

    expect(err.text()).toContain("error: invalid_input");
    expect(err.text()).toContain("tree is required");
  });
});

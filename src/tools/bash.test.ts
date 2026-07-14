/**
 * Vitest coverage for the jenkins_bash MCP tool adapter (D-01/D-02/D-07/
 * D-08/D-09). `JenkinsClient.get()` is mocked with fixture JSON throughout
 * — this suite never hits a live Jenkins instance or a real network host.
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "../jenkins/client.js";
import { CAP_BYTES, createBashHandler } from "./bash.js";

/** Builds a mocked `JenkinsClient` whose `get()` is driven by `handlers` (URL substring -> JSON body/string/Response). */
function createMockClient(handlers: Record<string, unknown>): {
  client: JenkinsClient;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (path: string) => {
    for (const [match, value] of Object.entries(handlers)) {
      if (path.startsWith(match)) {
        if (value instanceof Response) return value;
        if (typeof value === "string") return new Response(value, { status: 200 });
        return new Response(JSON.stringify(value), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  });
  const post = vi.fn(async () => new Response("{}", { status: 200 }));
  return { client: { get, post } as unknown as JenkinsClient, get };
}

/** Skeleton fixture: a folder containing one freestyle job, plus a top-level job. */
const SKELETON = {
  jobs: [
    {
      name: "team-a",
      _class: "com.cloudbees.hudson.plugins.folder.Folder",
      jobs: [
        {
          name: "app",
          _class: "hudson.model.FreeStyleProject",
          builds: [{ number: 1 }],
        },
      ],
    },
    {
      name: "job1",
      _class: "hudson.model.FreeStyleProject",
      builds: [{ number: 1 }],
    },
  ],
};

describe("createBashHandler", () => {
  it("Test 1 (READ-01): ls /jobs lists the fixture's top-level jobs/folders", async () => {
    const { client } = createMockClient({ "/api/json": SKELETON });
    const handler = createBashHandler(client);

    const result = await handler({ command: "ls /jobs" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("team-a");
    expect(text).toContain("job1");
  });

  describe("Test 2 (D-07): output cap", () => {
    it("caps a large console log at CAP_BYTES with a trailing truncation notice", async () => {
      const largeLog = "x".repeat(CAP_BYTES + 10_000);
      const { client } = createMockClient({
        "/api/json": SKELETON,
        "/job/job1/1/consoleText": largeLog,
      });
      const handler = createBashHandler(client);

      const result = await handler({ command: "cat /jobs/job1/builds/1/log" });
      const text = (result.content[0] as { text: string }).text;

      const [body, notice] = text.split("\n[truncated ");
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(CAP_BYTES);
      expect(notice).toContain("bytes — narrow with grep/tail");
      expect(notice).toContain(`${largeLog.length - CAP_BYTES}`);
    });

    it("returns a small output unchanged with no truncation notice", async () => {
      const smallLog = "line1\nline2\nERROR: boom\n";
      const { client } = createMockClient({
        "/api/json": SKELETON,
        "/job/job1/1/consoleText": smallLog,
      });
      const handler = createBashHandler(client);

      const result = await handler({ command: "cat /jobs/job1/builds/1/log" });
      const text = (result.content[0] as { text: string }).text;

      expect(text).toBe(smallLog);
      expect(text).not.toContain("truncated");
    });
  });

  it("Test 3 (D-08 no network): curl fails without throwing and without an outbound fetch attempt", async () => {
    const { client, get } = createMockClient({ "/api/json": SKELETON });
    const handler = createBashHandler(client);
    get.mockClear();

    const result = await handler({ command: "curl http://example.com" });
    const text = (result.content[0] as { text: string }).text;

    expect(text.toLowerCase()).toContain("curl");
    expect(text.toLowerCase()).toMatch(/not found|not permitted|command not found/);
    // The only Jenkins REST call made was the VFS skeleton fetch itself
    // (already cleared above, so this counts only calls made while running
    // the curl command) — curl never reaches out, since network is never
    // configured on the Bash sandbox (D-08, A4).
    expect(get).toHaveBeenCalledTimes(1); // buildJenkinsVfs's own skeleton fetch
  });

  it("Test 4 (D-08 read-only): rm surfaces the read-only-filesystem error and mutates nothing", async () => {
    const { client } = createMockClient({
      "/api/json": SKELETON,
      "/job/job1/api/json": { name: "job1", buildable: true },
    });
    const handler = createBashHandler(client);

    const result = await handler({ command: "rm /jobs/job1/api.json" });
    const text = (result.content[0] as { text: string }).text;

    expect(text.toLowerCase()).toContain("read-only");

    // A subsequent read of the same file still succeeds (nothing mutated).
    const { client: client2 } = createMockClient({
      "/api/json": SKELETON,
      "/job/job1/api/json": { name: "job1", buildable: true },
    });
    const handler2 = createBashHandler(client2);
    const readBack = await handler2({ command: "cat /jobs/job1/api.json" });
    const readBackText = (readBack.content[0] as { text: string }).text;
    expect(JSON.parse(readBackText)).toEqual({ name: "job1", buildable: true });
  });

  it("Test 5 (D-09 per-call freshness): two invocations each build a fresh VFS (re-fetch the skeleton)", async () => {
    const { client, get } = createMockClient({ "/api/json": SKELETON });
    const handler = createBashHandler(client);

    await handler({ command: "ls /jobs" });
    const callsAfterFirst = get.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await handler({ command: "ls /jobs" });
    const callsAfterSecond = get.mock.calls.length;

    // The skeleton endpoint is fetched again on the second invocation,
    // proving buildJenkinsVfs (and hence a fresh per-call VFS) is called
    // fresh each time rather than a cached VFS being reused (D-09).
    expect(callsAfterSecond).toBe(callsAfterFirst * 2);
  });

  it("propagates a JenkinsError from a VFS lazy provider (no local swallowing, matches whoami.ts)", async () => {
    // The skeleton fetch itself fails (client.get returns 500 for every
    // path), so buildJenkinsVfs throws a JenkinsError before any bash
    // sandbox is even constructed — this must reach the caller unchanged,
    // the same way whoami.ts lets a JenkinsError propagate.
    const failingClient: JenkinsClient = {
      get: vi.fn(async () => new Response("server error", { status: 500 })),
      post: vi.fn(async () => new Response("{}", { status: 200 })),
    };
    const failingHandler = createBashHandler(failingClient);

    await expect(failingHandler({ command: "ls /jobs" })).rejects.toMatchObject({
      name: "JenkinsError",
    });
  });
});

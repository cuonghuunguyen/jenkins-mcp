/**
 * Vitest coverage for the diagnosis extraction module (DIAG-01/DIAG-02,
 * D-01/D-03/D-04/D-06/D-07/D-08/D-09/D-10). `JenkinsClient.get()` is mocked
 * throughout, keyed by path substring (mirrors `server.test.ts`'s
 * `createMockClient` convention) — this suite never hits a live Jenkins
 * instance. `post` is a `vi.fn()` that is asserted to never be called
 * (read-only, D-01).
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "./client.js";
import {
  diagnoseBuild,
  extractMarkerRegion,
  findFailedNode,
  isPipelineBuildClass,
  REGION_CAP_BYTES,
  tailRegion,
  type WfapiDescribe,
} from "./diagnose.js";

/** A GET response fixture keyed by a path-substring matcher. */
interface GetFixture {
  match: string;
  body?: unknown;
  text?: string;
  status?: number;
}

/**
 * Builds a mocked `JenkinsClient` whose `get()` resolves fixtures in
 * registration order by matching the first fixture whose `match` substring
 * is contained in the requested path. `post` is a bare `vi.fn()` — tests
 * assert it is never called (read-only, D-01).
 */
function createMockClient(fixtures: GetFixture[]): {
  client: JenkinsClient;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn();

  const get = vi.fn(async (path: string) => {
    const fixture = fixtures.find((f) => path.includes(f.match));
    if (!fixture) {
      throw new Error(`No fixture registered for GET ${path}`);
    }
    const status = fixture.status ?? 200;
    if (fixture.text !== undefined) {
      return new Response(fixture.text, { status });
    }
    return new Response(JSON.stringify(fixture.body ?? {}), { status });
  });

  return { client: { get, post } as unknown as JenkinsClient, get, post };
}

describe("isPipelineBuildClass", () => {
  it("returns true for a build _class containing WorkflowRun", () => {
    expect(isPipelineBuildClass("org.jenkinsci.plugins.workflow.job.WorkflowRun")).toBe(true);
  });

  it("returns false for a freestyle build _class", () => {
    expect(isPipelineBuildClass("hudson.model.FreeStyleBuild")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPipelineBuildClass(undefined)).toBe(false);
  });
});

describe("findFailedNode", () => {
  it("returns the first node with an error object", () => {
    const describe_: WfapiDescribe = {
      stages: [
        {
          id: "1",
          name: "Build",
          status: "SUCCESS",
          stageFlowNodes: [{ id: "10", name: "sh", status: "SUCCESS" }],
        },
        {
          id: "2",
          name: "Test",
          status: "FAILED",
          stageFlowNodes: [
            { id: "20", name: "checkout", status: "SUCCESS" },
            { id: "21", name: "run tests", status: "FAILED", error: { message: "boom" } },
          ],
        },
      ],
    };
    const found = findFailedNode(describe_);
    expect(found?.stage.name).toBe("Test");
    expect(found?.node.name).toBe("run tests");
  });

  it("returns undefined when no stage/node is failed", () => {
    expect(findFailedNode({ stages: [] })).toBeUndefined();
    expect(findFailedNode({})).toBeUndefined();
  });
});

describe("extractMarkerRegion", () => {
  it("anchors on the LAST marker match with lines before/after", () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `line ${i}`),
      "an early error that is not the real one",
      ...Array.from({ length: 10 }, (_, i) => `filler ${i}`),
      "BUILD FAILED",
      "trailing line",
    ];
    const region = extractMarkerRegion(lines.join("\n"));
    expect(region).toBeDefined();
    expect(region).toMatch(/BUILD FAILED/);
    expect(region).toMatch(/trailing line/);
    // The earlier, non-last marker match's surrounding filler should not be
    // the anchor point (region should still contain some filler before the
    // last marker, but the anchor is the LAST match).
    expect(region?.indexOf("BUILD FAILED")).toBeGreaterThan(
      region?.indexOf("an early error") ?? -1,
    );
  });

  it("returns undefined when there is no marker match", () => {
    expect(extractMarkerRegion("all is well\nnothing to see here")).toBeUndefined();
  });
});

describe("tailRegion", () => {
  it("returns the log unchanged when within the cap", () => {
    expect(tailRegion("short log")).toBe("short log");
  });

  it("returns a byte-capped tail with a truncation notice when the log exceeds the cap", () => {
    const big = "x".repeat(REGION_CAP_BYTES * 2);
    const region = tailRegion(big);
    expect(Buffer.byteLength(region, "utf8")).toBeLessThan(REGION_CAP_BYTES * 2);
    expect(region).toMatch(/truncated/i);
  });
});

describe("diagnoseBuild", () => {
  const buildApiPath = "/api/json?tree=_class,result,building,url";

  it("D-04: reports not-finished for a still-building/queued target, no logRegion, hint mentions jenkins_bash", async () => {
    const { client, post } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: null,
          building: true,
          url: "http://jenkins/job/x/1/",
        },
      },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("not-finished");
    expect(result).not.toHaveProperty("logRegion");
    expect(result.hint).toMatch(/jenkins_bash/);
    expect(post).not.toHaveBeenCalled();
  });

  it("D-04: reports success for a SUCCESS build, no logRegion, hint says nothing to diagnose", async () => {
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "SUCCESS",
          building: false,
          url: "http://jenkins/job/x/1/",
        },
      },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("success");
    expect(result).not.toHaveProperty("logRegion");
    expect(result.hint).toMatch(/nothing to diagnose/i);
  });

  it("D-09: freestyle build returns not-a-pipeline with no wfapi request", async () => {
    const { client, get } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "hudson.model.FreeStyleBuild",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/1/",
        },
      },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("not-a-pipeline");
    expect(result.hint).toMatch(/pipeline/i);
    expect(result.hint).toMatch(/jenkins_bash/);
    const wfapiCalls = get.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes("wfapi"),
    );
    expect(wfapiCalls).toHaveLength(0);
  });

  it("D-10: pipeline build on a wfapi-less instance returns a distinct wfapi-unavailable message", async () => {
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/1/",
        },
      },
      { match: "/wfapi/describe", status: 404, body: {} },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("wfapi-unavailable");
    expect(result.hint).toMatch(/Pipeline REST API/i);
    expect(result.hint).toMatch(/jenkins_bash/);
  });

  it("Cascade 1: a failed node with a non-empty own log yields the precise diagnosed branch", async () => {
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/5/",
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "2",
              name: "Test",
              status: "FAILED",
              stageFlowNodes: [
                {
                  id: "21",
                  name: "run tests",
                  status: "FAILED",
                  error: { message: "boom" },
                  _links: { log: { href: "/job/x/5/execution/node/21/wfapi/log" } },
                },
              ],
            },
          ],
        },
      },
      { match: "/execution/node/21/wfapi/log", text: "precise node log content\nline2" },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("diagnosed");
    if (result.state === "diagnosed") {
      expect(result.failedStage).toBe("Test");
      expect(result.failedStep).toBe("run tests");
      expect(result.logRegion).toMatch(/precise node log content/);
    }
  });

  it("Cascade 1 byte cap (Pitfall 3): a node log larger than the region cap is capped with a truncation notice", async () => {
    const bigLog = "y".repeat(REGION_CAP_BYTES * 2);
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/5/",
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "2",
              name: "Test",
              status: "FAILED",
              stageFlowNodes: [
                {
                  id: "21",
                  name: "run tests",
                  status: "FAILED",
                  error: { message: "boom" },
                  _links: { log: { href: "/job/x/5/execution/node/21/wfapi/log" } },
                },
              ],
            },
          ],
        },
      },
      { match: "/execution/node/21/wfapi/log", text: bigLog },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("diagnosed");
    if (result.state === "diagnosed") {
      expect(Buffer.byteLength(result.logRegion, "utf8")).toBeLessThan(bigLog.length);
      expect(result.logRegion).toMatch(/truncated/i);
    }
  });

  it("Cascade 2: an empty node log falls through to marker-scan over consoleText", async () => {
    const consoleLines = [...Array.from({ length: 90 }, (_, i) => `filler ${i}`), "BUILD FAILED"];
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/5/",
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "2",
              name: "Test",
              status: "FAILED",
              stageFlowNodes: [
                {
                  id: "21",
                  name: "run tests",
                  status: "FAILED",
                  error: { message: "boom" },
                  _links: { log: { href: "/job/x/5/execution/node/21/wfapi/log" } },
                },
              ],
            },
          ],
        },
      },
      { match: "/execution/node/21/wfapi/log", text: "" },
      { match: "/consoleText", text: consoleLines.join("\n") },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("diagnosed");
    if (result.state === "diagnosed") {
      expect(result.logRegion).toMatch(/BUILD FAILED/);
    }
  });

  it("Cascade 2 with no node href: findFailedNode returns a node without a log href -> marker-scan consoleText", async () => {
    const consoleLines = [
      ...Array.from({ length: 90 }, (_, i) => `filler ${i}`),
      "an exception occurred",
    ];
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/5/",
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "2",
              name: "Test",
              status: "FAILED",
              stageFlowNodes: [
                { id: "21", name: "run tests", status: "FAILED", error: { message: "boom" } },
              ],
            },
          ],
        },
      },
      { match: "/consoleText", text: consoleLines.join("\n") },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("diagnosed");
    if (result.state === "diagnosed") {
      expect(result.logRegion).toMatch(/an exception occurred/);
    }
  });

  it("Cascade 3 (tail): consoleText has no marker match -> logRegion is the tail of consoleText", async () => {
    const consoleLines = Array.from({ length: 50 }, (_, i) => `plain line ${i}`);
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/x/5/",
        },
      },
      {
        match: "/wfapi/describe",
        body: { stages: [] },
      },
      { match: "/consoleText", text: consoleLines.join("\n") },
    ]);

    const result = await diagnoseBuild(client, { path: "x" });

    expect(result.state).toBe("diagnosed");
    if (result.state === "diagnosed") {
      expect(result.logRegion).toMatch(/plain line 49/);
    }
  });

  it("Error path: a 403 on the build api.json fetch throws a JenkinsError with no secret in the message", async () => {
    const { client } = createMockClient([{ match: buildApiPath, status: 403, body: {} }]);

    await expect(diagnoseBuild(client, { path: "x" })).rejects.toMatchObject({
      name: "JenkinsError",
    });
    try {
      await diagnoseBuild(client, { path: "x" });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toMatch(/token|crumb|cookie/i);
    }
  });

  it("targets /job/<path>/<n>/... instead of lastBuild when an explicit build number is given", async () => {
    const { client, get } = createMockClient([
      {
        match: "/job/x/7/api/json",
        body: {
          _class: "WorkflowRun",
          result: "SUCCESS",
          building: false,
          url: "http://jenkins/job/x/7/",
        },
      },
    ]);

    await diagnoseBuild(client, { path: "x", build: 7 });

    expect(get).toHaveBeenCalledWith(expect.stringContaining("/job/x/7/api/json"));
  });
});

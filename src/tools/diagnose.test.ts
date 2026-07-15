/**
 * Vitest coverage for the jenkins_diagnose_build MCP tool adapter (D-01/D-03/
 * D-05). `JenkinsClient.get()` is mocked as in `../jenkins/diagnose.test.ts`
 * — this suite never hits a live Jenkins instance.
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "../jenkins/client.js";
import {
  createDiagnoseHandler,
  DIAGNOSE_TOOL_NAME,
  diagnoseInputSchema,
} from "./diagnose.js";

interface GetFixture {
  match: string;
  body?: unknown;
  text?: string;
  status?: number;
}

function createMockClient(fixtures: GetFixture[]): {
  client: JenkinsClient;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (path: string) => {
    const fixture = fixtures.find((f) => path.includes(f.match));
    if (!fixture) throw new Error(`No fixture registered for GET ${path}`);
    const status = fixture.status ?? 200;
    if (fixture.text !== undefined) return new Response(fixture.text, { status });
    return new Response(JSON.stringify(fixture.body ?? {}), { status });
  });

  return { client: { get, post: vi.fn() } as unknown as JenkinsClient, get };
}

describe("DIAGNOSE_TOOL_NAME / diagnoseInputSchema", () => {
  it("DIAGNOSE_TOOL_NAME is jenkins_diagnose_build", () => {
    expect(DIAGNOSE_TOOL_NAME).toBe("jenkins_diagnose_build");
  });

  it("diagnoseInputSchema is a bare object literal exposing path (required) and build (optional)", () => {
    expect(diagnoseInputSchema).toHaveProperty("path");
    expect(diagnoseInputSchema).toHaveProperty("build");
    // zod schemas expose a `.parse` method; the bare-object convention means
    // diagnoseInputSchema itself is a plain object, NOT a z.object() wrapper.
    expect(typeof (diagnoseInputSchema as { parse?: unknown }).parse).toBe("undefined");
  });
});

describe("createDiagnoseHandler", () => {
  const buildApiPath = "/api/json?tree=_class,result,building,url";

  it("returns a CallToolResult whose text is JSON.stringify of the diagnosed result for a failed pipeline build", async () => {
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "FAILURE",
          building: false,
          url: "http://jenkins/job/my-job/9/",
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "1",
              name: "Test",
              status: "FAILED",
              stageFlowNodes: [
                {
                  id: "10",
                  name: "run tests",
                  status: "FAILED",
                  error: { message: "boom" },
                  _links: { log: { href: "/job/my-job/9/execution/node/10/wfapi/log" } },
                },
              ],
            },
          ],
        },
      },
      { match: "/execution/node/10/wfapi/log", text: "the precise failure log" },
    ]);

    const handler = createDiagnoseHandler(client);
    const result = await handler({ path: "my-job" });

    expect(result.content).toHaveLength(1);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.state).toBe("diagnosed");
    expect(payload.logRegion).toMatch(/precise failure log/);
  });

  it("targets /job/.../<n>/... rather than lastBuild when an explicit build number is given", async () => {
    const { client, get } = createMockClient([
      {
        match: "/job/my-job/3/api/json",
        body: {
          _class: "WorkflowRun",
          result: "SUCCESS",
          building: false,
          url: "http://jenkins/job/my-job/3/",
        },
      },
    ]);

    const handler = createDiagnoseHandler(client);
    await handler({ path: "my-job", build: 3 });

    expect(get).toHaveBeenCalledWith(expect.stringContaining("/job/my-job/3/api/json"));
    const calledWithLastBuild = get.mock.calls.some((call: unknown[]) =>
      (call[0] as string).includes("lastBuild"),
    );
    expect(calledWithLastBuild).toBe(false);
  });

  it("returns the success-state payload (no logRegion) for a SUCCESS build", async () => {
    const { client } = createMockClient([
      {
        match: buildApiPath,
        body: {
          _class: "WorkflowRun",
          result: "SUCCESS",
          building: false,
          url: "http://jenkins/job/my-job/9/",
        },
      },
    ]);

    const handler = createDiagnoseHandler(client);
    const result = await handler({ path: "my-job" });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.state).toBe("success");
    expect(payload).not.toHaveProperty("logRegion");
  });
});

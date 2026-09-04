/**
 * `jenkins build diagnose` wiring (DIAG-03).
 *
 * The subcommand name is load-bearing: `CLI_VOCABULARY` resolves core's
 * `{diagnose}` placeholder to the literal string `jenkins build diagnose`, so
 * a renamed subcommand would leave every hint in the package pointing at a
 * command that does not exist.
 */

import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import yargs, { type Argv } from "yargs";
import type { GlobalArgs } from "../commands/types.js";

const NODE_LOG = "/job/team-a/job/svc/12/execution/node/17/log";

const get = vi.fn(async (path: string) => {
  if (path.includes("/api/json?tree=jobs[")) {
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  }
  if (path.includes("tree=_class,number")) {
    return new Response(
      JSON.stringify({
        _class: "org.jenkinsci.plugins.workflow.job.WorkflowRun",
        number: 12,
        result: "FAILURE",
        building: false,
      }),
      { status: 200 },
    );
  }
  if (path.includes("wfapi/describe")) {
    return new Response(
      JSON.stringify({
        stages: [
          {
            id: "16",
            name: "Test",
            status: "FAILED",
            stageFlowNodes: [
              { id: "17", name: "sh", status: "FAILED", _links: { log: { href: NODE_LOG } } },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  }
  if (path.includes("testReport")) {
    return new Response(
      JSON.stringify({
        failCount: 1,
        totalCount: 9,
        suites: [{ cases: [{ className: "a.Foo", name: "breaks", status: "FAILED" }] }],
      }),
      { status: 200 },
    );
  }
  if (path === NODE_LOG) return new Response("mvn verify\nBUILD FAILURE", { status: 200 });
  return new Response("not found", { status: 404 });
});

const post = vi.fn();

vi.mock("../client.js", () => ({
  createSession: () => ({
    client: { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient,
    cache: new JenkinsCache(),
    config: { indexDepth: 4 },
  }),
}));

vi.mock("../job.js", () => ({
  gitOriginUrl: async () => undefined,
  resolveJob: async () => "team-a/svc",
}));

const { registerBuildCommand } = await import("../commands/build.js");

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function parser() {
  const root = yargs([])
    .option("job", { type: "string" })
    .option("json", { type: "boolean", default: false })
    .exitProcess(false) as unknown as Argv<GlobalArgs>;
  return registerBuildCommand(root);
}

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

describe("jenkins build diagnose (DIAG-03)", () => {
  it("prints the failed stage, the failed tests and the failed step's log", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "diagnose", "12"]);

    const text = out();
    expect(text).toContain("team-a/svc #12  FAILURE");
    expect(text).toContain("failedStage: Test");
    expect(text).toContain("failed tests (1)");
    expect(text).toContain("BUILD FAILURE");
    // Tests above the log, and no {ref} placeholder left unresolved.
    expect(text.indexOf("failed tests")).toBeLessThan(text.indexOf("log ("));
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(text).toContain("next: jenkins log with mode=step step=Test");
    expect(post).not.toHaveBeenCalled();
  });

  it("emits the raw structured data under --json, with no truncation marker in it", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "diagnose", "12", "--json"]);

    const data = JSON.parse(out());
    expect(data.state).toBe("diagnosed");
    expect(data.region.source).toBe("failed-step");
    expect(data.region.text).toBe("mvn verify\nBUILD FAILURE");
    expect(data.tests.failed[0].name).toBe("breaks");
  });
});

/**
 * Diagnosis v2 coverage (DIAG-03).
 *
 * Every test asserts WHICH cascade branch produced the answer, not merely
 * that some region came back — the whole point of v2 is that the source of
 * the region is part of the answer. `client` is faked, never global fetch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import { formatDiagnoseResult } from "../format/diagnose.js";
import {
  DIAGNOSE_FAILED_TEST_CAP,
  diagnoseBuild,
  findFailedNode,
  isPipelineBuildClass,
  REGION_HARD_CAP_BYTES,
} from "../operations/diagnose.js";
import { createMockClient, type GetFixture } from "./fixtures.js";

const PIPELINE = "org.jenkinsci.plugins.workflow.job.WorkflowRun";
const FREESTYLE = "hudson.model.FreeStyleProject$FreeStyleBuild";

const NODE_LOG_HREF = "/job/team-a/job/svc/3/execution/node/17/log";

/** A `wfapi/describe` whose stage `Test` failed and carries its own log href. */
const DESCRIBE_WITH_FAILED_NODE = {
  stages: [
    {
      id: "6",
      name: "Build",
      status: "SUCCESS",
      stageFlowNodes: [{ id: "7", name: "sh", status: "SUCCESS" }],
    },
    {
      id: "16",
      name: "Test",
      status: "FAILED",
      stageFlowNodes: [
        {
          id: "17",
          name: "sh mvn verify",
          status: "FAILED",
          _links: { log: { href: NODE_LOG_HREF } },
        },
      ],
    },
  ],
};

function buildApi(over: Record<string, unknown> = {}): GetFixture {
  return {
    match: "?tree=_class,number",
    body: {
      _class: PIPELINE,
      number: 3,
      result: "FAILURE",
      building: false,
      url: "https://jenkins.example.com/job/team-a/job/svc/3/",
      ...over,
    },
  };
}

function testReport(cases: Array<Record<string, unknown>>, counts = {}): GetFixture {
  return {
    match: "testReport",
    body: { failCount: 2, totalCount: 40, suites: [{ cases }], ...counts },
  };
}

/** Fixtures must be ordered so `testReport` is matched before `/api/json`. */
function client(fixtures: GetFixture[]) {
  return createMockClient(fixtures);
}

const ARGS = { job: "team-a/svc", build: 3 };

afterEach(() => {
  vi.useRealTimers();
});

describe("isPipelineBuildClass", () => {
  it("classifies a build _class, not a job _class", () => {
    expect(isPipelineBuildClass(PIPELINE)).toBe(true);
    expect(isPipelineBuildClass(FREESTYLE)).toBe(false);
    // The JOB-level pipeline class must NOT read as a pipeline BUILD.
    expect(isPipelineBuildClass("org.jenkinsci.plugins.workflow.job.WorkflowJob")).toBe(false);
    expect(isPipelineBuildClass(undefined)).toBe(false);
  });
});

describe("findFailedNode", () => {
  it("returns the first node with an error or FAILED status, with its stage", () => {
    const found = findFailedNode(DESCRIBE_WITH_FAILED_NODE);
    expect(found?.stage.name).toBe("Test");
    expect(found?.node.name).toBe("sh mvn verify");
  });

  it("returns undefined for an empty or all-green describe", () => {
    expect(findFailedNode({})).toBeUndefined();
    expect(
      findFailedNode({
        stages: [{ id: "1", name: "a", status: "SUCCESS", stageFlowNodes: [{ id: "2" }] }],
      }),
    ).toBeUndefined();
  });
});

describe("cascade 1 — the failed step's own log", () => {
  it("returns the failed node's log, followed via its OWN href", async () => {
    const {
      client: c,
      get,
      post,
    } = client([
      testReport([], { failCount: 0, totalCount: 40, suites: [] }),
      buildApi(),
      { match: "wfapi/describe", body: DESCRIBE_WITH_FAILED_NODE },
      { match: NODE_LOG_HREF, text: "mvn verify\nBUILD FAILURE" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    expect(result.state).toBe("diagnosed");
    if (result.state !== "diagnosed") return;
    expect(result.failedStage).toBe("Test");
    expect(result.failedStep).toBe("sh mvn verify");
    expect(result.region?.source).toBe("failed-step");
    expect(result.region?.text).toContain("BUILD FAILURE");
    // The console is never fetched when a step log answered.
    expect(get.mock.calls.some(([p]) => String(p).endsWith("/consoleText"))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("falls through when the node log comes back empty", async () => {
    const { client: c } = client([
      testReport([], { failCount: 0, totalCount: 0, suites: [] }),
      buildApi(),
      { match: "wfapi/describe", body: DESCRIBE_WITH_FAILED_NODE },
      { match: NODE_LOG_HREF, text: "" },
      { match: "consoleText", text: "line one\nline two" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    expect(result.state).toBe("diagnosed");
    if (result.state !== "diagnosed") return;
    // The stage attribution survives even though its log did not.
    expect(result.failedStage).toBe("Test");
    expect(result.region?.source).toBe("console-tail");
  });
});

describe("cascade 2 — the failed tests", () => {
  it("collects FAILED and REGRESSION cases and ignores the rest", async () => {
    const { client: c } = client([
      testReport([
        { className: "a.Foo", name: "passes", status: "PASSED" },
        { className: "a.Foo", name: "breaks", status: "FAILED", errorDetails: "expected 1 got 2" },
        {
          className: "a.Bar",
          name: "regressed",
          status: "REGRESSION",
          errorStackTrace: "at a.Bar\n  ...",
        },
        { className: "a.Baz", name: "skipped", status: "SKIPPED" },
      ]),
      buildApi(),
      { match: "wfapi/describe", body: DESCRIBE_WITH_FAILED_NODE },
      { match: NODE_LOG_HREF, text: "surefire noise" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    expect(result.tests?.failedTotal).toBe(2);
    expect(result.tests?.failed.map((t) => t.name)).toEqual(["breaks", "regressed"]);
    // errorStackTrace stands in when errorDetails is absent.
    expect(result.tests?.failed[1]?.detail).toContain("at a.Bar");
    expect(result.tests?.totalCount).toBe(40);
    // Runs IN ADDITION to the step log, not instead of it.
    expect(result.region?.source).toBe("failed-step");
  });

  it("caps the case list and carries the true count", async () => {
    const many = Array.from({ length: DIAGNOSE_FAILED_TEST_CAP + 4 }, (_, i) => ({
      className: "a.Foo",
      name: `t${i}`,
      status: "FAILED",
    }));
    const { client: c } = client([
      testReport(many, { failCount: many.length, totalCount: 50 }),
      buildApi({ _class: FREESTYLE }),
      { match: "consoleText", text: "irrelevant" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "log-only") throw new Error(`unexpected state ${result.state}`);
    expect(result.tests?.failed.length).toBe(DIAGNOSE_FAILED_TEST_CAP);
    expect(result.tests?.failedTotal).toBe(DIAGNOSE_FAILED_TEST_CAP + 4);
  });

  it("treats a 404 test report as 'no report', never an error", async () => {
    const { client: c } = client([
      { match: "testReport", status: 404, text: "not found" },
      buildApi(),
      { match: "wfapi/describe", body: DESCRIBE_WITH_FAILED_NODE },
      { match: NODE_LOG_HREF, text: "" },
      { match: "consoleText", text: "tail text" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    expect(result.tests).toBeUndefined();
    expect(result.region?.source).toBe("console-tail");
  });
});

describe("cascade 3 — the console tail, and only as a fallback", () => {
  it("is used when neither a step log nor a failed test exists", async () => {
    const { client: c } = client([
      testReport([], { failCount: 0, totalCount: 12, suites: [] }),
      buildApi(),
      // A pipeline whose describe names no failed node at all.
      { match: "wfapi/describe", body: { stages: [] } },
      { match: "consoleText", text: "start\nmiddle\nthe real end" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    expect(result.failedStage).toBeUndefined();
    expect(result.region?.source).toBe("console-tail");
    expect(result.region?.text.endsWith("the real end")).toBe(true);
  });

  it("does NOT fire when the test report already named the failures", async () => {
    const { client: c, get } = client([
      testReport([{ className: "a.Foo", name: "breaks", status: "FAILED" }], { failCount: 1 }),
      buildApi(),
      { match: "wfapi/describe", body: { stages: [] } },
      { match: "consoleText", text: "should not be read" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    expect(result.region).toBeUndefined();
    expect(get.mock.calls.some(([p]) => String(p).endsWith("/consoleText"))).toBe(false);
  });

  it("the marker scan is gone: a mid-log 'ERROR' line no longer becomes the region", async () => {
    const console = [
      "step 1 ok",
      "WARNING: unused import in error-handling.ts",
      "ERROR: could not resolve optional dependency, continuing",
      ...Array.from({ length: 200 }, (_, i) => `progress ${i}`),
      "the actual last line",
    ].join("\n");

    const { client: c } = client([
      { match: "testReport", status: 404, text: "" },
      buildApi(),
      { match: "wfapi/describe", body: { stages: [] } },
      { match: "consoleText", text: console },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    // v1 would have returned a window centred on the mid-log ERROR line and
    // labelled it the diagnosis. v2 returns the honest whole tail instead.
    expect(result.region?.source).toBe("console-tail");
    expect(result.region?.text).toBe(console);
    expect(formatDiagnoseResult(result)).toContain("console tail");
  });
});

describe("freestyle builds", () => {
  it("returns log-only with its test report, and never calls wfapi", async () => {
    const { client: c, get } = client([
      testReport([{ className: "a.Foo", name: "breaks", status: "FAILED" }], { failCount: 1 }),
      buildApi({ _class: FREESTYLE }),
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    expect(result.state).toBe("log-only");
    if (result.state !== "log-only") return;
    expect(result.reason).toBe("freestyle");
    expect(result.tests?.failedTotal).toBe(1);
    expect(get.mock.calls.some(([p]) => String(p).includes("wfapi"))).toBe(false);
  });

  it("falls back to the console tail when it has no test report", async () => {
    const { client: c } = client([
      { match: "testReport", status: 404, text: "" },
      buildApi({ _class: FREESTYLE }),
      { match: "consoleText", text: "freestyle output\nfinished: FAILURE" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "log-only") throw new Error(`unexpected state ${result.state}`);
    expect(result.tests).toBeUndefined();
    expect(result.region?.source).toBe("console-tail");
  });
});

describe("a pipeline without the wfapi plugin", () => {
  it("degrades to log-only rather than a dead end", async () => {
    const { client: c } = client([
      { match: "testReport", status: 404, text: "" },
      buildApi(),
      { match: "wfapi/describe", status: 404, text: "not found" },
      { match: "consoleText", text: "console body" },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "log-only") throw new Error(`unexpected state ${result.state}`);
    expect(result.reason).toBe("wfapi-unavailable");
    expect(result.region?.text).toBe("console body");
  });
});

describe("non-failure branches carry no region", () => {
  it("reports a still-building build and stops", async () => {
    const { client: c, get } = client([buildApi({ result: null, building: true })]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    expect(result).toMatchObject({ state: "not-finished", result: null, number: 3 });
    expect("region" in result).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reports a successful build and stops", async () => {
    const { client: c, get } = client([buildApi({ result: "SUCCESS" })]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    expect(result).toMatchObject({ state: "success", result: "SUCCESS" });
    expect("region" in result).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("capping", () => {
  it("returns the region uncapped from the operation and caps it in the formatter", async () => {
    const huge = `${"x".repeat(30_000)}\nlast`;
    const { client: c } = client([
      { match: "testReport", status: 404, text: "" },
      buildApi(),
      { match: "wfapi/describe", body: DESCRIBE_WITH_FAILED_NODE },
      { match: NODE_LOG_HREF, text: huge },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    // The operation hands back the whole thing plus its honest size, so a
    // --json caller gets data rather than a truncation marker.
    expect(result.region?.text).toBe(huge);
    expect(result.region?.bytes).toBe(Buffer.byteLength(huge, "utf8"));
    expect(result.region?.text).not.toContain("[truncated");

    const text = formatDiagnoseResult(result);
    expect(text).toContain("[truncated");
    expect(text).toContain("mode=step step=Test");
  });

  it("hard-bounds a pathological log in the operation while reporting its true size", async () => {
    const enormous = "y".repeat(REGION_HARD_CAP_BYTES + 500);
    const { client: c } = client([
      { match: "testReport", status: 404, text: "" },
      buildApi(),
      { match: "wfapi/describe", body: { stages: [] } },
      { match: "consoleText", text: enormous },
    ]);

    const result = await diagnoseBuild(c, new JenkinsCache(), ARGS);

    if (result.state !== "diagnosed") throw new Error(`unexpected state ${result.state}`);
    expect(result.region?.bytes).toBe(REGION_HARD_CAP_BYTES + 500);
    expect(Buffer.byteLength(result.region?.text ?? "", "utf8")).toBe(REGION_HARD_CAP_BYTES);
  });
});

describe("cache tier", () => {
  it("caches a finished numeric build permanently and a permalink volatilely", async () => {
    vi.useFakeTimers();

    const fixtures = (): GetFixture[] => [
      { match: "testReport", status: 404, text: "" },
      buildApi(),
      { match: "wfapi/describe", body: { stages: [] } },
      { match: "consoleText", text: "body" },
    ];

    const numeric = new JenkinsCache();
    const { client: c1 } = client(fixtures());
    await diagnoseBuild(c1, numeric, ARGS);
    const afterFirst = numeric.loadCount();
    vi.advanceTimersByTime(11_000);
    await diagnoseBuild(c1, numeric, ARGS);
    expect(numeric.loadCount()).toBe(afterFirst);

    const alias = new JenkinsCache();
    const { client: c2 } = client(fixtures());
    await diagnoseBuild(c2, alias, { job: "team-a/svc" });
    const aliasFirst = alias.loadCount();
    vi.advanceTimersByTime(11_000);
    await diagnoseBuild(c2, alias, { job: "team-a/svc" });
    expect(alias.loadCount()).toBe(aliasFirst + 1);
  });

  it("keeps a still-building numeric build volatile", async () => {
    vi.useFakeTimers();
    const cache = new JenkinsCache();
    const { client: c } = client([buildApi({ result: null, building: true })]);

    await diagnoseBuild(c, cache, ARGS);
    vi.advanceTimersByTime(11_000);
    await diagnoseBuild(c, cache, ARGS);

    expect(cache.loadCount()).toBe(2);
  });
});

describe("errors", () => {
  it("surfaces a non-ok build probe as a JenkinsError, not a raw response", async () => {
    const { client: c } = client([{ match: "?tree=_class,number", status: 403, text: "nope" }]);

    await expect(diagnoseBuild(c, new JenkinsCache(), ARGS)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("formatDiagnoseResult", () => {
  const base = { job: "team-a/svc", ref: "PR-42", selector: "3", number: 3 };

  it("puts the failed tests above the log region", () => {
    const text = formatDiagnoseResult({
      ...base,
      state: "diagnosed",
      result: "FAILURE",
      failedStage: "Test",
      failedStep: "sh mvn verify",
      tests: {
        failCount: 1,
        totalCount: 40,
        failedTotal: 1,
        failed: [{ className: "a.Foo", name: "breaks", detail: "expected 1\nbut got 2" }],
      },
      region: { source: "failed-step", text: "boom", bytes: 4, startLine: 1 },
    });

    expect(text.indexOf("failed tests")).toBeLessThan(text.indexOf("log ("));
    expect(text).toContain("team-a/svc @ PR-42 #3  FAILURE");
    expect(text).toContain("failedStage: Test");
    // A multi-line assertion message is collapsed to one row.
    expect(text).toContain("expected 1");
    expect(text).not.toContain("but got 2");
    expect(text).toContain("1  boom");
    expect(text).toContain("next: {log} with mode=step step=Test");
  });

  it("states 'no test report' rather than leaving a silent gap", () => {
    const text = formatDiagnoseResult({
      ...base,
      state: "log-only",
      reason: "freestyle",
      result: "FAILURE",
      region: { source: "console-tail", text: "out", bytes: 3, startLine: 1 },
    });

    expect(text).toContain("no test report");
    expect(text).toContain("no stage data (not a pipeline build)");
    // A console-tail region widens by asking for more TAIL. Pointing at
    // `mode=failed` would route the agent into operations/log.ts's
    // last-error-marker scan - the very heuristic DIAG-03 deleted from this
    // module for being confidently wrong.
    expect(text).toContain("next: {log} with mode=tail lines=500");
    expect(text).not.toContain("mode=failed");
  });

  it("renders one honest line for a build with nothing to diagnose", () => {
    expect(formatDiagnoseResult({ ...base, state: "success", result: "SUCCESS" })).toContain(
      "SUCCESS — nothing to diagnose",
    );
    expect(formatDiagnoseResult({ ...base, state: "not-finished", result: null })).toContain(
      "BUILDING — nothing to diagnose yet",
    );
  });

  it("emits no literal tool or command name — core speaks in {ref} placeholders", () => {
    const text = formatDiagnoseResult({
      ...base,
      state: "diagnosed",
      result: "FAILURE",
      region: { source: "console-tail", text: "out", bytes: 3, startLine: 1 },
    });

    expect(text).not.toMatch(/jenkins_[a-z_]+/);
    expect(text).not.toMatch(/jenkins [a-z]+/);
  });
});

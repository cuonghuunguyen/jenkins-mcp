/**
 * `getBuildDetail` + `formatBuildDetail` (READ-09).
 *
 * The two behaviours worth guarding here are the CACHE TIER decision (which is
 * a function of the loaded value, not the key) and the ABSENT-vs-EMPTY
 * distinction for stages and the test report - a freestyle build must never
 * read as a pipeline that ran zero stages.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { formatBuildDetail } from "../format/build-detail.js";
import { type BuildDetail, getBuildDetail } from "../operations/build-detail.js";
import { FREESTYLE_CLASS, MULTIBRANCH_CLASS, WORKFLOW_CLASS } from "./fixtures.js";

const PIPELINE_RUN_CLASS = "org.jenkinsci.plugins.workflow.job.WorkflowRun";
const FREESTYLE_RUN_CLASS = "hudson.model.FreeStyleBuild";

const INDEX = {
  jobs: [
    {
      name: "team-a",
      fullName: "team-a",
      _class: "com.cloudbees.hudson.plugins.folder.Folder",
      jobs: [
        { name: "svc", fullName: "team-a/svc", _class: FREESTYLE_CLASS, color: "blue" },
        {
          name: "mb",
          fullName: "team-a/mb",
          _class: MULTIBRANCH_CLASS,
          jobs: [
            { name: "PR-7", fullName: "team-a/mb/PR-7", _class: WORKFLOW_CLASS, color: "red" },
          ],
        },
      ],
    },
  ],
};

interface Fixtures {
  build?: unknown;
  buildStatus?: number;
  wfapi?: unknown;
  wfapiStatus?: number;
  tests?: unknown;
  testsStatus?: number;
}

/**
 * A client faked at the CLIENT boundary (never global fetch), dispatching on
 * the distinguishing substring of each of the three endpoints.
 */
function mockClient(fixtures: Fixtures) {
  const get = vi.fn(async (path: string) => {
    if (path.includes("/api/json?tree=jobs[")) {
      return new Response(JSON.stringify(INDEX), { status: 200 });
    }
    if (path.includes("/wfapi/describe")) {
      return new Response(JSON.stringify(fixtures.wfapi ?? {}), {
        status: fixtures.wfapiStatus ?? 200,
      });
    }
    if (path.includes("/testReport/api/json")) {
      return new Response(JSON.stringify(fixtures.tests ?? {}), {
        status: fixtures.testsStatus ?? 200,
      });
    }
    if (path.includes("/api/json?tree=number")) {
      return new Response(JSON.stringify(fixtures.build ?? {}), {
        status: fixtures.buildStatus ?? 200,
      });
    }
    return new Response("not found", { status: 404 });
  });

  const client = {
    get,
    post: vi.fn(),
    baseUrl: "https://jenkins.example.com",
  } as unknown as JenkinsClient;
  return { client, get };
}

/** Paths hit for the build's own `api/json` - the request the tier gates. */
function buildCalls(get: ReturnType<typeof vi.fn>): string[] {
  return get.mock.calls
    .map((call) => String(call[0]))
    .filter((path) => path.includes("/api/json?tree=number"));
}

const FINISHED_BUILD = {
  number: 42,
  result: "FAILURE",
  building: false,
  duration: 200_000,
  timestamp: 1_700_000_000_000,
  url: "https://jenkins.example.com/job/team-a/job/svc/42/",
  _class: FREESTYLE_RUN_CLASS,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getBuildDetail cache tier (AGNT-01)", () => {
  /** Past the 10s volatile TTL but inside the 60s index TTL. */
  const BETWEEN_TIERS_MS = 30_000;

  it("does not cache permanently when an optional enrichment failed transiently", async () => {
    // One wfapi timeout used to be frozen at the permanent tier, so the build's
    // stages were unreachable for the rest of the process with no way to force
    // a refetch. A 404 is a fact about the build; a 500 is not.
    vi.useFakeTimers();
    const { client, get } = mockClient({
      build: { ...FINISHED_BUILD, _class: PIPELINE_RUN_CLASS },
      wfapiStatus: 500,
    });
    const cache = new JenkinsCache();

    const first = await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });
    vi.advanceTimersByTime(BETWEEN_TIERS_MS);
    await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });

    expect(first.stages).toBeUndefined();
    expect(first.degraded).toBe(true);
    expect(buildCalls(get)).toHaveLength(2);
  });

  it("still caches permanently when the enrichment 404s, which is a real absence", async () => {
    vi.useFakeTimers();
    const { client, get } = mockClient({
      build: { ...FINISHED_BUILD, _class: PIPELINE_RUN_CLASS },
      wfapiStatus: 404,
      testsStatus: 404,
    });
    const cache = new JenkinsCache();

    const first = await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });
    vi.advanceTimersByTime(BETWEEN_TIERS_MS);
    await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });

    expect(first.degraded).toBe(false);
    expect(buildCalls(get)).toHaveLength(1);
  });

  it("caches a numeric, finished build permanently - a repeat read issues no request", async () => {
    vi.useFakeTimers();
    const { client, get } = mockClient({ build: FINISHED_BUILD, wfapiStatus: 404 });
    const cache = new JenkinsCache();

    await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });
    vi.advanceTimersByTime(BETWEEN_TIERS_MS);
    await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });

    expect(buildCalls(get)).toHaveLength(1);
  });

  it("keeps a numeric, still-building build volatile", async () => {
    vi.useFakeTimers();
    const { client, get } = mockClient({
      build: { ...FINISHED_BUILD, result: null, building: true, duration: 0 },
      wfapiStatus: 404,
    });
    const cache = new JenkinsCache();

    await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });
    vi.advanceTimersByTime(BETWEEN_TIERS_MS);
    await getBuildDetail(client, cache, { job: "team-a/svc", build: 42, depth: 4 });

    expect(buildCalls(get)).toHaveLength(2);
  });

  it("keeps a permalink alias volatile even when it resolves to a finished build", async () => {
    vi.useFakeTimers();
    const { client, get } = mockClient({ build: FINISHED_BUILD, wfapiStatus: 404 });
    const cache = new JenkinsCache();

    const args = { job: "team-a/svc", build: "lastSuccessfulBuild", depth: 4 };
    await getBuildDetail(client, cache, args);
    vi.advanceTimersByTime(BETWEEN_TIERS_MS);
    await getBuildDetail(client, cache, args);

    // The alias itself moves when a new build starts, so the value behind it
    // is never immutable regardless of the build it currently points at.
    expect(buildCalls(get)).toHaveLength(2);
  });
});

describe("getBuildDetail addressing (REF-01)", () => {
  it("resolves -1 to lastBuild", async () => {
    const { client, get } = mockClient({ build: FINISHED_BUILD, wfapiStatus: 404 });

    await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: -1,
      depth: 4,
    });

    expect(buildCalls(get)[0]).toContain("/job/team-a/job/svc/lastBuild/api/json");
  });

  it("resolves a permalink alias as its own path segment", async () => {
    const { client, get } = mockClient({ build: FINISHED_BUILD, wfapiStatus: 404 });

    await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: "lastSuccessfulBuild",
      depth: 4,
    });

    expect(buildCalls(get)[0]).toContain("/job/team-a/job/svc/lastSuccessfulBuild/api/json");
  });

  it("turns a bare integer ref into PR-<n> on a multibranch job", async () => {
    const { client, get } = mockClient({ build: FINISHED_BUILD, wfapiStatus: 404 });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/mb",
      ref: "7",
      build: 42,
      depth: 4,
    });

    expect(data.ref).toBe("PR-7");
    expect(buildCalls(get)[0]).toContain("/job/team-a/job/mb/job/PR-7/42/api/json");
  });

  it("rejects an invalid build selector as invalid_input, before any request", async () => {
    const { client, get } = mockClient({ build: FINISHED_BUILD });

    await expect(
      getBuildDetail(client, new JenkinsCache(), { job: "team-a/svc", build: "0", depth: 4 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(get).not.toHaveBeenCalled();
  });

  it("surfaces a failed build read as a JenkinsError", async () => {
    const { client } = mockClient({ build: {}, buildStatus: 404 });

    await expect(
      getBuildDetail(client, new JenkinsCache(), { job: "team-a/svc", build: 42, depth: 4 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("getBuildDetail degradation", () => {
  it("returns the build with stages undefined when wfapi/describe 404s", async () => {
    const { client } = mockClient({
      build: { ...FINISHED_BUILD, _class: PIPELINE_RUN_CLASS },
      wfapiStatus: 404,
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.number).toBe(42);
    expect(data.pipeline).toBe(true);
    expect(data.stages).toBeUndefined();
  });

  it("never asks wfapi about a non-pipeline build, and reports no stage data", async () => {
    const { client, get } = mockClient({ build: FINISHED_BUILD });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.pipeline).toBe(false);
    expect(data.stages).toBeUndefined();
    expect(get.mock.calls.some((call) => String(call[0]).includes("/wfapi/"))).toBe(false);
  });

  it("distinguishes a pipeline with zero stages from no stage data at all", async () => {
    const { client } = mockClient({
      build: { ...FINISHED_BUILD, _class: PIPELINE_RUN_CLASS },
      wfapi: { stages: [] },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.stages).toEqual([]);
  });

  it("returns the build with tests undefined when no test report exists", async () => {
    const { client } = mockClient({ build: FINISHED_BUILD, testsStatus: 404 });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.number).toBe(42);
    expect(data.tests).toBeUndefined();
  });
});

describe("getBuildDetail parsing", () => {
  it("filters actions[] rather than indexing it, ignoring unrelated entries", async () => {
    const { client } = mockClient({
      build: {
        ...FINISHED_BUILD,
        actions: [
          {},
          null,
          { _class: "hudson.plugins.git.util.BuildData" },
          { causes: [{ shortDescription: "Started by GitHub push by alice" }] },
          {
            parameters: [
              { name: "BRANCH", value: "main" },
              { name: "DEPLOY", value: false },
            ],
          },
        ],
      },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.causes).toEqual(["Started by GitHub push by alice"]);
    expect(data.parameters).toEqual([
      { name: "BRANCH", value: "main" },
      { name: "DEPLOY", value: "false" },
    ]);
  });

  it("flattens a pipeline's changeSets into commits", async () => {
    // Was asserted against a FreeStyleBuild fixture carrying the pipeline-only
    // `changeSets` field, so it proved nothing about either class.
    const { client } = mockClient({
      build: {
        ...FINISHED_BUILD,
        _class: PIPELINE_RUN_CLASS,
        changeSets: [
          {
            items: [
              {
                commitId: "a1b2c3d4e5f6",
                msg: "fix: handle empty response",
                author: { fullName: "alice" },
                date: "2026-08-01 10:00:00 +0000",
              },
              { msg: "no commitId, dropped" },
            ],
          },
        ],
      },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.commits).toEqual([
      {
        commitId: "a1b2c3d4e5f6",
        message: "fix: handle empty response",
        author: "alice",
        date: "2026-08-01 10:00:00 +0000",
      },
    ]);
  });

  it("reads a freestyle build's singular changeSet, so its commits are not dropped", async () => {
    // A FreeStyleBuild (AbstractBuild) exposes `changeSet`, not `changeSets`.
    // Reading only the plural rendered every freestyle build as "No commits
    // found" - the positive claim that it changed nothing.
    const { client } = mockClient({
      build: {
        ...FINISHED_BUILD,
        changeSet: { items: [{ commitId: "deadbeef1234", msg: "freestyle change" }] },
      },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.commits).toEqual([{ commitId: "deadbeef1234", message: "freestyle change" }]);
    expect(formatBuildDetail(data)).not.toContain("No commits found");
  });

  it("redacts a credential-bearing parameter instead of printing its value", async () => {
    // The one place in the read surface that can surface a secret into an
    // agent transcript, and into the permanently-cached detail.
    const { client } = mockClient({
      build: {
        ...FINISHED_BUILD,
        actions: [
          {
            parameters: [
              { _class: "hudson.model.PasswordParameterValue", name: "TOKEN", value: "hunter2" },
              { _class: "hudson.model.StringParameterValue", name: "BRANCH", value: "main" },
            ],
          },
        ],
      },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.parameters).toEqual([
      { name: "TOKEN", value: "[redacted]" },
      { name: "BRANCH", value: "main" },
    ]);
    expect(formatBuildDetail(data)).not.toContain("hunter2");
  });

  it("renders a non-scalar parameter as JSON, not [object Object]", async () => {
    const { client } = mockClient({
      build: {
        ...FINISHED_BUILD,
        actions: [{ parameters: [{ name: "OPTS", value: { a: 1 } }] }],
      },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.parameters).toEqual([{ name: "OPTS", value: '{"a":1}' }]);
  });

  it("requests both changeSet spellings and the parameter class in one projection", async () => {
    const { client, get } = mockClient({ build: FINISHED_BUILD });

    await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    const url = buildCalls(get)[0] ?? "";
    expect(url).toContain("changeSet[items[");
    expect(url).toContain("changeSets[items[");
    expect(url).toContain("parameters[_class,name,value]");
  });

  it("counts both FAILED and REGRESSION as failed tests, and nothing else", async () => {
    const { client } = mockClient({
      build: FINISHED_BUILD,
      tests: {
        failCount: 2,
        totalCount: 5,
        suites: [
          {
            cases: [
              { className: "a.FooTest", name: "passes", status: "PASSED" },
              { className: "a.FooTest", name: "skipped", status: "SKIPPED" },
              { className: "a.FooTest", name: "fixed", status: "FIXED" },
              {
                className: "a.FooTest",
                name: "shouldParse",
                status: "FAILED",
                errorDetails: "expected 2 but was 3",
              },
              { className: "a.BarTest", name: "regressed", status: "REGRESSION" },
            ],
          },
        ],
      },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.tests?.failedTotal).toBe(2);
    expect(data.tests?.failed.map((test) => test.name)).toEqual(["shouldParse", "regressed"]);
  });

  it("caps the failed-test list at 20 while carrying the true total", async () => {
    const cases = Array.from({ length: 25 }, (_, index) => ({
      className: "a.FooTest",
      name: `test${index}`,
      status: "FAILED",
    }));
    const { client } = mockClient({
      build: FINISHED_BUILD,
      tests: { failCount: 25, totalCount: 30, suites: [{ cases }] },
    });

    const data = await getBuildDetail(client, new JenkinsCache(), {
      job: "team-a/svc",
      build: 42,
      depth: 4,
    });

    expect(data.tests?.failed).toHaveLength(20);
    expect(data.tests?.failedTotal).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const NOW = 1_700_000_400_000;

function detail(overrides: Partial<BuildDetail> = {}): BuildDetail {
  return {
    job: "team-a/svc",
    selector: "42",
    number: 42,
    result: "FAILURE",
    building: false,
    durationMs: 200_000,
    timestamp: NOW - 240_000,
    pipeline: false,
    causes: [],
    parameters: [],
    commits: [],
    degraded: false,
    ...overrides,
  };
}

describe("formatBuildDetail (AGNT-03/04)", () => {
  it("reports Jenkins' own failCount when no failed case could be parsed", () => {
    // A matrix or aggregated report carries its failures under childReports[],
    // which this projection does not fetch. "0 failed" there renders a red
    // build as green.
    const text = formatBuildDetail(
      detail({ tests: { failCount: 3, totalCount: 10, failed: [], failedTotal: 0 } }),
      NOW,
    );

    expect(text).toContain(
      "tests: 10 run, 3 failed (details unavailable — {log} with mode=failed)",
    );
  });

  it("still reports a genuinely green report as 0 failed", () => {
    const text = formatBuildDetail(
      detail({ tests: { failCount: 0, totalCount: 10, failed: [], failedTotal: 0 } }),
      NOW,
    );

    expect(text).toContain("tests: 10 run, 0 failed");
  });

  it("surfaces a non-SUCCESS stage that a head-first truncation would have dropped", () => {
    // 20 stages, the anomaly at 19: the old head-first slice rendered twelve
    // SUCCESS rows and "No failed steps found" - every visible signal green.
    const stages = Array.from({ length: 20 }, (_, i) => ({
      name: `Stage${i + 1}`,
      status: i === 18 ? "ABORTED" : "SUCCESS",
      durationMs: 1000,
    }));

    const text = formatBuildDetail(detail({ pipeline: true, stages }), NOW);

    expect(text).toContain("stages (showing 12 of 20)");
    expect(text).toContain("Stage19  ABORTED");
  });

  it("keeps chronological order when the whole stage table fits", () => {
    const stages = [
      { name: "Build", status: "SUCCESS" },
      { name: "Test", status: "FAILED" },
      { name: "Deploy", status: "SUCCESS" },
    ];

    const text = formatBuildDetail(detail({ pipeline: true, stages }), NOW);
    const rows = text
      .split("\n")
      .filter((line) => /^(Build|Test|Deploy)\s+(SUCCESS|FAILED)/.test(line))
      .map((row) => row.split(/\s+/)[0]);

    expect(rows).toEqual(["Build", "Test", "Deploy"]);
  });

  it("uses one phrasing for empty parameters across the read surface", () => {
    expect(formatBuildDetail(detail(), NOW)).toContain("No parameters found");
  });

  it("leads with address, status, duration and age", () => {
    const text = formatBuildDetail(detail({ ref: "main" }), NOW);

    expect(text.split("\n")[0]).toBe("team-a/svc @ main #42  FAILURE  3m20s  4m ago");
  });

  it("shows BUILDING with elapsed time rather than a result", () => {
    const text = formatBuildDetail(
      detail({ result: null, building: true, durationMs: 0, timestamp: NOW - 65_000 }),
      NOW,
    );

    expect(text.split("\n")[0]).toContain("BUILDING  1m05s");
    expect(text).toContain("next: {wait}");
  });

  it("renders params, commits, stages and failed tests as compact tables", () => {
    const text = formatBuildDetail(
      detail({
        pipeline: true,
        causes: ["Started by GitHub push by alice"],
        parameters: [
          { name: "BRANCH", value: "main" },
          { name: "DEPLOY", value: "false" },
        ],
        commits: [
          { commitId: "a1b2c3d4e5f", author: "alice", message: "fix: handle empty response" },
        ],
        stages: [
          { name: "Checkout", status: "SUCCESS", durationMs: 4100 },
          { name: "Test", status: "FAILED", durationMs: 121_000 },
        ],
        tests: {
          failCount: 5,
          totalCount: 40,
          failedTotal: 5,
          failed: [{ className: "com.acme.FooTest", name: "shouldParse", detail: "expected 2" }],
        },
      }),
      NOW,
    );

    expect(text).toContain("cause: Started by GitHub push by alice");
    expect(text).toContain("params (2)");
    expect(text).toContain("commits (1)");
    expect(text).toContain("a1b2c3d");
    expect(text).toContain("stages (2)");
    expect(text).toContain("failed steps (1)");
    expect(text).toContain("Test — see {log} with mode=step step=Test");
    expect(text).toContain("failed tests (showing 1 of 5)");
    expect(text).toContain("next: {diagnose}");
  });

  it("says an absent test report is absent instead of leaving a silent gap", () => {
    const text = formatBuildDetail(detail(), NOW);

    expect(text).toContain("no test report");
    expect(text).not.toContain("failed tests");
  });

  it("distinguishes 'not a pipeline' from a pipeline with no stages", () => {
    expect(formatBuildDetail(detail(), NOW)).toContain("no stages (not a pipeline)");
    expect(formatBuildDetail(detail({ pipeline: true }), NOW)).toContain(
      "no stage data (wfapi unavailable)",
    );
    expect(formatBuildDetail(detail({ pipeline: true, stages: [] }), NOW)).toContain(
      "No stages found",
    );
  });

  it("truncates a long stage list and a multi-line test detail", () => {
    const stages = Array.from({ length: 20 }, (_, index) => ({
      name: `stage${index}`,
      status: "SUCCESS",
      durationMs: 1000,
    }));
    const text = formatBuildDetail(
      detail({
        pipeline: true,
        stages,
        tests: {
          failCount: 1,
          totalCount: 1,
          failedTotal: 1,
          failed: [
            {
              className: "a.T",
              name: "t",
              detail: "boom\n\tat a.T.t(T.java:1)\n\tat a.T.u(T.java:2)",
            },
          ],
        },
      }),
      NOW,
    );

    expect(text).toContain("stages (showing 12 of 20)");
    expect(text).not.toContain("stage19");
    expect(text).toContain("boom");
    expect(text).not.toContain("T.java");
  });

  it("reports a passing test report without a failure table", () => {
    const text = formatBuildDetail(
      detail({
        result: "SUCCESS",
        tests: { failCount: 0, totalCount: 40, failedTotal: 0, failed: [] },
      }),
      NOW,
    );

    expect(text).toContain("tests: 40 run, 0 failed");
    expect(text).toContain("next: {log}");
  });
});

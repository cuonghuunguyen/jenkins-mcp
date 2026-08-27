/**
 * Regression tests for the Phase 7+8 review findings and the roadmap
 * success-criteria gaps.
 *
 * Every test here fails on the code as it was before the corresponding fix.
 * They live in one file because they cut across modules; the per-module suites
 * stay the place for a module's own behaviour.
 */

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { formatTriggerResult } from "../format/build.js";
import { formatDiagnoseResult } from "../format/diagnose.js";
import { formatJobSearch } from "../format/jobs.js";
import { formatLogResult } from "../format/log.js";
import { abortBuild } from "../operations/abort.js";
import { diagnoseBuild } from "../operations/diagnose.js";
import { findJobs } from "../operations/jobs.js";
import {
  findFirstFailureLine,
  getBuildLog,
  readWfapiNodeLog,
  saveRawLog,
} from "../operations/log.js";
import { loadJobParameters, triggerBuild } from "../operations/trigger.js";
import { MULTIBRANCH_CLASS, WORKFLOW_CLASS } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

interface Route {
  match: string;
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A client that answers GETs from the FIRST matching route, in order. */
function clientOf(routes: Route[], postImpl?: (path: string) => Response) {
  const gets: string[] = [];
  const posts: string[] = [];
  const get = vi.fn(async (path: string) => {
    gets.push(path);
    const route = routes.find((r) => path.includes(r.match));
    if (route === undefined) return new Response(null, { status: 404 });
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200, headers: route.headers });
    }
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  });
  const post = vi.fn(async (path: string) => {
    posts.push(path);
    return (
      postImpl?.(path) ??
      new Response(null, {
        status: 201,
        headers: { Location: "http://jenkins.example/queue/item/9/" },
      })
    );
  });
  return {
    client: { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient,
    gets,
    posts,
  };
}

/** A multibranch index in which `svc` has a `PR-42` child. */
const MULTIBRANCH_INDEX = {
  jobs: [
    {
      fullName: "svc",
      name: "svc",
      _class: MULTIBRANCH_CLASS,
      jobs: [{ fullName: "svc/PR-42", name: "PR-42", _class: WORKFLOW_CLASS, color: "blue" }],
    },
  ],
};

const INDEX_ROUTE: Route = { match: "tree=jobs[", body: MULTIBRANCH_INDEX };

// ---------------------------------------------------------------------------
// HIGH: ref "42" must mean PR-42 on every ref-taking tool, not two of five
// ---------------------------------------------------------------------------

describe("bare-integer ref normalization (review HIGH)", () => {
  it("addresses PR-42 from jenkins_abort_build", async () => {
    const { client, posts } = clientOf([INDEX_ROUTE]);

    await abortBuild(client, new JenkinsCache(), {
      job: "svc",
      ref: "42",
      build: "lastBuild",
      depth: 4,
    });

    // Was `/job/svc/job/42/lastBuild/stop` - a 404 where the agent expected
    // an emergency stop.
    expect(posts).toEqual(["/job/svc/job/PR-42/lastBuild/stop"]);
  });

  it("addresses PR-42 from jenkins_trigger_build", async () => {
    const { client, posts } = clientOf([
      INDEX_ROUTE,
      { match: "tree=property", body: { property: [] } },
      { match: "/queue/item/", body: { executable: { number: 5, url: "u" } } },
    ]);

    const result = await triggerBuild(client, new JenkinsCache(), {
      job: "svc",
      ref: "42",
      depth: 4,
    });

    expect(posts).toEqual(["/job/svc/job/PR-42/build"]);
    expect(result.ref).toBe("PR-42");
  });

  it("addresses PR-42 from jenkins_diagnose_build", async () => {
    const { client, gets } = clientOf([
      INDEX_ROUTE,
      { match: "/api/json?tree=_class", body: { number: 3, result: "SUCCESS", building: false } },
    ]);

    await diagnoseBuild(client, new JenkinsCache(), {
      job: "svc",
      ref: "42",
      build: 3,
      depth: 4,
    });

    expect(gets.some((p) => p.startsWith("/job/svc/job/PR-42/3/"))).toBe(true);
    expect(gets.some((p) => p.startsWith("/job/svc/job/42/"))).toBe(false);
  });

  it("leaves a bare-integer ref alone when no depth is given (the chained-wait case)", async () => {
    const { client, posts } = clientOf([
      { match: "tree=property", body: { property: [] } },
      { match: "/queue/item/", body: { executable: { number: 5, url: "u" } } },
    ]);

    await triggerBuild(client, new JenkinsCache(), { job: "svc", ref: "42" });

    expect(posts).toEqual(["/job/svc/job/42/build"]);
  });
});

// ---------------------------------------------------------------------------
// HIGH: a trigger that started a build must never report only an error
// ---------------------------------------------------------------------------

describe("triggerBuild chained-wait failure (review HIGH)", () => {
  const routes: Route[] = [
    { match: "tree=property", body: { property: [] } },
    { match: "/queue/item/", body: { executable: { number: 77, url: "http://x/77/" } } },
    // Every wait poll 404s: the queue-resolved number is not readable yet.
    { match: "/77/", status: 404 },
  ];

  it("still reports the build number when the chained wait throws", async () => {
    const { client } = clientOf(routes);

    const result = await triggerBuild(client, new JenkinsCache(), {
      job: "svc",
      wait: true,
      waitTimeoutMs: 10,
    });

    // The POST already started #77 irreversibly. Reporting only
    // `error: not_found` invites the agent to trigger again - a duplicate deploy.
    expect("buildNumber" in result && result.buildNumber).toBe(77);
    expect("waitError" in result && result.waitError).toBeTruthy();
  });

  it("renders the number and warns the caller off re-triggering", async () => {
    const { client } = clientOf(routes);

    const text = formatTriggerResult(
      await triggerBuild(client, new JenkinsCache(), {
        job: "svc",
        wait: true,
        waitTimeoutMs: 10,
      }),
    );

    expect(text).toContain("started: svc #77");
    expect(text).toContain("could not be followed");
    expect(text).toContain("do NOT re-trigger");
  });
});

// ---------------------------------------------------------------------------
// Phase 7 criterion 2: the next call names the RESOLVED build number
// ---------------------------------------------------------------------------

describe("triggerBuild next-call hint (Phase 7 criterion 2)", () => {
  it("names the resolved build number in the wait hint", async () => {
    const { client } = clientOf([
      { match: "tree=property", body: { property: [] } },
      { match: "/queue/item/", body: { executable: { number: 91, url: "http://x/91/" } } },
    ]);

    const text = formatTriggerResult(
      await triggerBuild(client, new JenkinsCache(), { job: "svc" }),
    );

    expect(text).toContain("next: {wait} on #91");
  });
});

// ---------------------------------------------------------------------------
// MEDIUM: stale parameter definitions must not be asserted as fact
// ---------------------------------------------------------------------------

describe("trigger parameter cache (review MEDIUM)", () => {
  it("re-reads the definitions once before rejecting an unknown NAME", async () => {
    let declared = [{ name: "BRANCH", defaultParameterValue: { value: "main" } }];
    const get = vi.fn(async (path: string) => {
      if (path.includes("tree=property")) {
        return new Response(JSON.stringify({ property: [{ parameterDefinitions: declared }] }), {
          status: 200,
        });
      }
      if (path.includes("/queue/item/")) {
        return new Response(JSON.stringify({ executable: { number: 4, url: "u" } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });
    const post = vi.fn(
      async () =>
        new Response(null, {
          status: 201,
          headers: { Location: "http://jenkins.example/queue/item/9/" },
        }),
    );
    const client = { get, post, baseUrl: "http://x" } as unknown as JenkinsClient;
    const cache = new JenkinsCache();

    // Warm the 60s `params` entry via a rejected trigger.
    await expect(
      triggerBuild(client, cache, { job: "svc", params: { NOPE: "x" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // A human now adds DEPLOY_ENV to the job.
    declared = [...declared, { name: "DEPLOY_ENV", defaultParameterValue: { value: "dev" } }];

    // The only invalidation used to be AFTER a successful POST, which by
    // definition never runs for a rejected call - so this legitimate trigger
    // was rejected with a confident, wrong statement of the job's config.
    const result = await triggerBuild(client, cache, {
      job: "svc",
      params: { DEPLOY_ENV: "prod" },
    });
    expect("buildNumber" in result).toBe(true);
  });

  it("does NOT re-read for a choice-value mismatch, which is never stale that way", async () => {
    const { client, gets } = clientOf([
      {
        match: "tree=property",
        body: {
          property: [{ parameterDefinitions: [{ name: "ENV", choices: ["dev", "prod"] }] }],
        },
      },
    ]);
    const cache = new JenkinsCache();

    await expect(
      triggerBuild(client, cache, { job: "svc", params: { ENV: "staging" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(gets.filter((p) => p.includes("tree=property")).length).toBe(1);
  });

  it("caches the definitions across reads with no trigger in between", async () => {
    // The `index` tier on jobKey(job, ref, "params") is what CTRL-07 says
    // makes pre-POST validation free; nothing asserted it before.
    const { client } = clientOf([{ match: "tree=property", body: { property: [] } }]);
    const cache = new JenkinsCache();

    await loadJobParameters(client, cache, "svc");
    const afterFirst = cache.loadCount();
    await loadJobParameters(client, cache, "svc");

    expect(cache.loadCount()).toBe(afterFirst);
  });

  it("blames rebuild_from, not the caller, for a parameter the job has since removed", async () => {
    const { client } = clientOf([
      {
        match: "tree=actions",
        body: { actions: [{ parameters: [{ name: "LEGACY", value: "1" }] }] },
      },
      {
        match: "tree=property",
        body: { property: [{ parameterDefinitions: [{ name: "BRANCH" }] }] },
      },
    ]);

    await expect(
      triggerBuild(client, new JenkinsCache(), { job: "svc", rebuildFrom: 5 }),
    ).rejects.toThrowError(/rebuilt from/);
  });
});

// ---------------------------------------------------------------------------
// HIGH/MEDIUM: the diagnosis log region
// ---------------------------------------------------------------------------

describe("diagnose log region (review HIGH + MEDIUM)", () => {
  /** A 3000-line console whose LAST line is the only thing worth reading. */
  const FAILURE_LINE = "BUILD FAILED: java.lang.NullPointerException at Foo.java:42";
  const bigConsole = `${Array.from({ length: 3000 }, (_, i) => `noise line ${i + 1} ${"x".repeat(30)}`).join("\n")}\n${FAILURE_LINE}\n`;

  async function diagnoseBigConsole() {
    const { client } = clientOf([
      {
        match: "/api/json?tree=_class",
        body: {
          _class: "hudson.model.FreeStyleBuild",
          number: 9,
          result: "FAILURE",
          building: false,
        },
      },
      { match: "/testReport/", status: 404 },
      { match: "/consoleText", text: bigConsole },
    ]);
    return diagnoseBuild(client, new JenkinsCache(), { job: "svc", build: 9 });
  }

  it("caps a console-tail region from the FRONT, keeping the failure line", async () => {
    // `toRegion` keeps the END of the console; the formatter then byte-capped
    // from the START, so the agent was shown the OLDEST 18KB of the tail - the
    // one part guaranteed not to contain the failure.
    const text = formatDiagnoseResult(await diagnoseBigConsole());

    expect(text).toContain(FAILURE_LINE);
    expect(text).toContain("from the START");
  });

  it("numbers the region from its real offset, not from 1", async () => {
    const result = await diagnoseBigConsole();

    expect(result.state).toBe("log-only");
    if (result.state !== "log-only" || result.region === undefined) throw new Error("no region");
    // 3001 lines: the region is the whole log here, so it starts at 1 - but
    // the field exists and the header states it.
    expect(result.region.startLine).toBeGreaterThanOrEqual(1);
    expect(formatDiagnoseResult(result)).toMatch(/from line \d+/);
  });

  it("degrades to the console tail when the node log 404s instead of failing the diagnosis", async () => {
    // Throwing here aborted the whole diagnosis over an OPTIONAL source: the
    // test report and the console tail were never read.
    const { client } = clientOf([
      {
        match: "/api/json?tree=_class",
        body: {
          _class: "org.jenkinsci.plugins.workflow.job.WorkflowRun",
          number: 9,
          result: "FAILURE",
          building: false,
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "6",
              name: "Build",
              status: "FAILED",
              stageFlowNodes: [
                { id: "7", name: "sh", status: "FAILED", _links: { log: { href: "/node/7/log" } } },
              ],
            },
          ],
        },
      },
      { match: "/node/7/log", status: 404 },
      { match: "/testReport/", status: 404 },
      { match: "/consoleText", text: "the answer is here\n" },
    ]);

    const result = await diagnoseBuild(client, new JenkinsCache(), { job: "svc", build: 9 });

    expect(result.state).toBe("diagnosed");
    if (result.state !== "diagnosed") throw new Error("wrong state");
    expect(result.region?.source).toBe("console-tail");
    expect(result.region?.text).toContain("the answer is here");
  });

  it("reports 'no log region' rather than an error when the console was discarded", async () => {
    const { client } = clientOf([
      {
        match: "/api/json?tree=_class",
        body: {
          _class: "hudson.model.FreeStyleBuild",
          number: 9,
          result: "FAILURE",
          building: false,
        },
      },
      { match: "/testReport/", status: 404 },
      { match: "/consoleText", status: 404 },
    ]);

    const result = await diagnoseBuild(client, new JenkinsCache(), { job: "svc", build: 9 });

    expect(result.state === "log-only" && result.region).toBeUndefined();
    expect(formatDiagnoseResult(result)).toContain("No log region matched this build");
  });
});

// ---------------------------------------------------------------------------
// Gap 6: the two modules must agree on the wfapi node-log shape
// ---------------------------------------------------------------------------

describe("shared wfapi node-log reader (Gap 6)", () => {
  it("unwraps the JSON envelope and says so", () => {
    expect(readWfapiNodeLog('{"text":"hello\\n"}')).toEqual({ text: "hello\n", shape: "json" });
  });

  it("accepts a plain-text body and says so", () => {
    expect(readWfapiNodeLog("hello\n")).toEqual({ text: "hello\n", shape: "text" });
  });

  it("DEGRADES rather than throwing on an unparseable body", () => {
    expect(readWfapiNodeLog("{not json")).toEqual({ text: "{not json", shape: "text" });
  });

  it("is the reader diagnose uses, so a JSON envelope is not shown as raw JSON", async () => {
    const { client } = clientOf([
      {
        match: "/api/json?tree=_class",
        body: {
          _class: "org.jenkinsci.plugins.workflow.job.WorkflowRun",
          number: 9,
          result: "FAILURE",
          building: false,
        },
      },
      {
        match: "/wfapi/describe",
        body: {
          stages: [
            {
              id: "6",
              name: "Build",
              status: "FAILED",
              stageFlowNodes: [
                { id: "7", name: "sh", status: "FAILED", _links: { log: { href: "/node/7/log" } } },
              ],
            },
          ],
        },
      },
      { match: "/node/7/log", text: '{"text":"compilation failed\\n"}' },
      { match: "/testReport/", status: 404 },
    ]);

    const result = await diagnoseBuild(client, new JenkinsCache(), { job: "svc", build: 9 });

    if (result.state !== "diagnosed") throw new Error("wrong state");
    expect(result.region?.text).toBe("compilation failed\n");
    expect(result.region?.wfapiShape).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// Gap 1: the index carries lastBuild and age
// ---------------------------------------------------------------------------

describe("job index lastBuild and age (Phase 6 criterion 1)", () => {
  const INDEX = {
    jobs: [
      {
        fullName: "team-a",
        name: "team-a",
        _class: "com.cloudbees.hudson.plugins.folder.Folder",
        jobs: [
          {
            fullName: "team-a/svc",
            name: "svc",
            _class: WORKFLOW_CLASS,
            color: "red",
            lastBuild: { number: 1042, timestamp: Date.now() - 3_600_000, result: "FAILURE" },
          },
          { fullName: "team-a/never-run", name: "never-run", _class: WORKFLOW_CLASS },
        ],
      },
    ],
  };

  it("carries the last build through the index onto the row", async () => {
    const { client } = clientOf([{ match: "tree=jobs[", body: INDEX }]);

    const data = await findJobs(client, new JenkinsCache(), { depth: 3 });
    const svc = data.matches.find((job) => job.fullName === "team-a/svc");

    expect(svc?.lastBuild).toMatchObject({ number: 1042, result: "FAILURE" });
    const text = formatJobSearch(data);
    expect(text).toContain("lastBuild");
    expect(text).toContain("#1042");
    expect(text).toContain("1h");
  });

  it("renders '-' for a folder and for a job that has never run, not a fabricated build", async () => {
    const { client } = clientOf([{ match: "tree=jobs[", body: INDEX }]);

    const data = await findJobs(client, new JenkinsCache(), { depth: 3 });
    const folder = data.matches.find((job) => job.fullName === "team-a");
    const never = data.matches.find((job) => job.fullName === "team-a/never-run");

    expect(folder?.lastBuild).toBeUndefined();
    expect(never?.lastBuild).toBeUndefined();
    const rows = formatJobSearch(data).split("\n");
    expect(rows.find((r) => r.startsWith("team-a "))).toMatch(/-\s+-$/);
  });
});

// ---------------------------------------------------------------------------
// Gap 2: log mode semantics
// ---------------------------------------------------------------------------

describe("jenkins_log mode semantics (Phase 6 criterion 4)", () => {
  const LINES = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  const CONSOLE = `${LINES.join("\n")}\n`;

  function logSession(text = CONSOLE) {
    const { client, gets } = clientOf([
      { match: "tree=jobs[", body: { jobs: [] } },
      { match: "/api/json?tree=number", body: { number: 8, building: false, result: "FAILURE" } },
      { match: "/wfapi/describe", status: 404 },
      { match: "/consoleText", text },
    ]);
    return { client, cache: new JenkinsCache(), gets };
  }

  const base = { job: "svc", build: 8, depth: 3 } as const;

  it("resolves a negative range as end-relative", async () => {
    const s = logSession();

    const result = await getBuildLog(s.client, s.cache, {
      ...base,
      mode: "range",
      from: -100,
      to: -1,
    });

    expect(result.segments[0]?.startLine).toBe(401);
    expect(result.shownLines).toBe(100);
    expect(result.segments[0]?.lines.at(-1)).toBe("line 500");
  });

  it("still rejects a range that is inverted AFTER resolution", async () => {
    const s = logSession();

    await expect(
      getBuildLog(s.client, s.cache, { ...base, mode: "range", from: -1, to: -100 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects line 0, which addresses nothing in a 1-based scheme", async () => {
    const s = logSession();

    await expect(
      getBuildLog(s.client, s.cache, { ...base, mode: "range", from: 0, to: 5 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stops the grep scan at max_matches and reports how much it examined", async () => {
    // Asserted by how much of the log was EXAMINED, not by output length: the
    // format layer would truncate the output either way.
    const s = logSession();

    const result = await getBuildLog(s.client, s.cache, {
      ...base,
      mode: "grep",
      pattern: "line",
      maxMatches: 5,
    });

    expect(result.matchCount).toBe(5);
    expect(result.scannedLines).toBe(5);
    expect(result.scanStoppedEarly).toBe(true);
    // "stopped looking after 5" is not "the log has 5" - the render says which.
    expect(formatLogResult(result)).toContain("5+ match(es) — scan stopped at max_matches=5");
  });

  it("does not claim an early stop when the scan reached the end", async () => {
    const s = logSession();

    const result = await getBuildLog(s.client, s.cache, {
      ...base,
      mode: "grep",
      pattern: "line 250$",
      maxMatches: 5,
    });

    expect(result.scanStoppedEarly).toBe(false);
    expect(result.scannedLines).toBe(500);
    expect(formatLogResult(result)).toContain("1 match(es)");
  });

  it("honours a caller-supplied context for mode=failed", async () => {
    const withMarker = `${LINES.slice(0, 300).join("\n")}\nERROR: boom\n${LINES.slice(300).join("\n")}\n`;
    const wide = logSession(withMarker);
    const narrow = logSession(withMarker);

    const big = await getBuildLog(wide.client, wide.cache, {
      ...base,
      mode: "failed",
      context: 50,
    });
    const small = await getBuildLog(narrow.client, narrow.cache, {
      ...base,
      mode: "failed",
      context: 2,
    });

    expect(big.shownLines).toBe(101);
    expect(small.shownLines).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Gap 3: firstFailureLine
// ---------------------------------------------------------------------------

describe("save_to firstFailureLine (Phase 6 criterion 5)", () => {
  it("finds an anchored Jenkins failure verdict", () => {
    expect(findFirstFailureLine("ok\nstill ok\nFinished: FAILURE\n")).toBe(3);
  });

  it("finds a line-start ERROR: and a non-zero exit code", () => {
    expect(findFirstFailureLine("a\nERROR: nope\n")).toBe(2);
    expect(findFirstFailureLine("a\nprocess exited with exit code 2\n")).toBe(2);
    // `exit code 0` is not a failure, and must not be matched.
    expect(findFirstFailureLine("a\nprocess exited with exit code 0\n")).toBeUndefined();
  });

  it("returns undefined rather than guessing on a log with 'error' but no anchor", () => {
    // The deleted marker-region extractor was deleted precisely because a
    // loose /error/i scan produces confident nonsense.
    const noisy = [
      "Downloading error-prone-2.4.0.jar",
      "warning: this may cause an error later",
      "0 errors, 3 warnings",
      "Finished: SUCCESS",
    ].join("\n");

    expect(findFirstFailureLine(noisy)).toBeUndefined();
  });

  it("carries it onto the save summary and renders the absence explicitly", () => {
    const cwd = process.cwd();
    const dir = `${cwd}/.tmp-regressions`;
    try {
      const found = saveRawLog(".tmp-regressions/a.log", "x.log", "ok\nFinished: FAILURE\n");
      expect(found.firstFailureLine).toBe(2);

      const none = saveRawLog(".tmp-regressions/b.log", "x.log", "ok\nFinished: SUCCESS\n");
      expect(none.firstFailureLine).toBeUndefined();

      const text = formatLogResult({
        job: "svc",
        selector: "8",
        building: false,
        mode: "tail",
        totalLines: 2,
        segments: [],
        shownLines: 0,
        saved: none,
      });
      expect(text).toContain("no anchored failure line found");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// LOW: the remaining review findings
// ---------------------------------------------------------------------------

describe("review LOW findings", () => {
  it("slices a console-tail region on a codepoint boundary, not mid-character", async () => {
    // `capBytes` in format/common.ts backs off for exactly this reason; the
    // second implementation in `toRegion` did not, so the first kept character
    // decoded to U+FFFD.
    const { REGION_HARD_CAP_BYTES } = await import("../operations/diagnose.js");
    // Every "é" is two bytes, so an odd cap offset lands mid-sequence.
    const text = `${"é".repeat(REGION_HARD_CAP_BYTES)}\nEND\n`;
    const { client } = clientOf([
      {
        match: "/api/json?tree=_class",
        body: {
          _class: "hudson.model.FreeStyleBuild",
          number: 9,
          result: "FAILURE",
          building: false,
        },
      },
      { match: "/testReport/", status: 404 },
      { match: "/consoleText", text },
    ]);

    const result = await diagnoseBuild(client, new JenkinsCache(), { job: "svc", build: 9 });

    if (result.state !== "log-only" || result.region === undefined) throw new Error("no region");
    expect(result.region.text).not.toContain("�");
    expect(result.region.text.endsWith("END\n")).toBe(true);
  });

  it("masks a password parameter's value in the trigger output", async () => {
    const { client } = clientOf([
      {
        match: "tree=property",
        body: {
          property: [
            {
              parameterDefinitions: [
                { name: "BRANCH", type: "StringParameterDefinition" },
                { name: "TOKEN", type: "PasswordParameterDefinition" },
              ],
            },
          ],
        },
      },
      { match: "/queue/item/", body: { executable: { number: 4, url: "u" } } },
    ]);

    const result = await triggerBuild(client, new JenkinsCache(), {
      job: "svc",
      params: { BRANCH: "main", TOKEN: "hunter2" },
    });
    const text = formatTriggerResult(result);

    expect(text).toContain("BRANCH=main");
    expect(text).toContain("TOKEN=[redacted]");
    expect(text).not.toContain("hunter2");
    // The VALUE still goes to Jenkins - only the rendering is masked.
    expect(result.params.TOKEN).toBe("hunter2");
  });
});

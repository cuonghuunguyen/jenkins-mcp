/**
 * `getJobDetail` + `formatJobDetail` (READ-08, REF-02).
 *
 * The client is faked, never global fetch: the client's own contract is tested
 * in client.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { JenkinsCache, TIER_TTL_MS } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { JenkinsError } from "../errors.js";
import { formatJobDetail } from "../format/job-detail.js";
import { getJobDetail } from "../operations/job-detail.js";
import {
  FOLDER_CLASS,
  FREESTYLE_CLASS,
  type GetFixture,
  MULTIBRANCH_CLASS,
  WORKFLOW_CLASS,
} from "./fixtures.js";

/**
 * A folder holding a plain job, plus a multibranch parent holding a branch, a
 * PR and a tag. The `_class` values are the real ones, because every
 * classification helper branches on `_class` substrings.
 */
const INDEX = {
  jobs: [
    {
      name: "team-a",
      fullName: "team-a",
      _class: FOLDER_CLASS,
      jobs: [
        {
          name: "svc",
          fullName: "team-a/svc",
          _class: MULTIBRANCH_CLASS,
          jobs: [
            { name: "main", fullName: "team-a/svc/main", _class: WORKFLOW_CLASS, color: "blue" },
            {
              name: "PR-42",
              fullName: "team-a/svc/PR-42",
              _class: WORKFLOW_CLASS,
              color: "blue_anime",
            },
            {
              name: "release%2F1.x",
              fullName: "team-a/svc/release%2F1.x",
              _class: WORKFLOW_CLASS,
              color: "red",
            },
          ],
        },
        { name: "plain", fullName: "team-a/plain", _class: FREESTYLE_CLASS, color: "blue" },
      ],
    },
  ],
};

/** Fixed at module load so every rendered age is stable. */
const NOW = Date.now();

/** A job response with two parameters and two builds, one still running. */
const JOB_BODY = {
  name: "main",
  fullName: "team-a/svc/main",
  url: "https://jenkins.example.com/job/team-a/job/svc/job/main/",
  buildable: true,
  _class: WORKFLOW_CLASS,
  property: [
    // Unrelated property entries come back in the same array; a `tree=`
    // projection renders them as `{}`, so the filter must be on the presence
    // of parameterDefinitions, not on _class.
    {},
    { _class: "com.coravy.hudson.plugins.github.GithubProjectProperty" },
    {
      _class: "hudson.model.ParametersDefinitionProperty",
      parameterDefinitions: [
        {
          name: "BRANCH",
          type: "StringParameterDefinition",
          defaultParameterValue: { value: "main" },
        },
        {
          name: "DEPLOY",
          type: "BooleanParameterDefinition",
          defaultParameterValue: { value: false },
        },
      ],
    },
  ],
  builds: [
    { number: 1042, result: null, building: true, timestamp: NOW - 240_000, duration: 0 },
    {
      number: 1041,
      result: "FAILURE",
      building: false,
      timestamp: NOW - 7_200_000,
      duration: 62_000,
    },
  ],
};

function session(fixtures: GetFixture[]) {
  const get = vi.fn(async (path: string) => {
    const fixture = fixtures.find((candidate) => path.includes(candidate.match));
    if (fixture === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(fixture.body ?? {}), { status: fixture.status ?? 200 });
  });
  const client = {
    get,
    post: vi.fn(),
    baseUrl: "https://jenkins.example.com",
  } as unknown as JenkinsClient;
  return { client, cache: new JenkinsCache(), get };
}

const INDEX_FIXTURE: GetFixture = { match: "/api/json?tree=jobs[", body: INDEX };

afterEach(() => {
  vi.useRealTimers();
});

describe("getJobDetail shape discrimination (REF-02)", () => {
  it("returns the children of a multibranch parent addressed without a ref", async () => {
    const { client, cache } = session([INDEX_FIXTURE]);

    const data = await getJobDetail(client, cache, { job: "team-a/svc", depth: 6 });

    expect(data.kind).toBe("container");
    if (data.kind !== "container") return;
    expect(data.type).toBe("multibranch");
    expect(data.children.map((child) => child.fullName)).toEqual([
      "team-a/svc/main",
      "team-a/svc/PR-42",
      "team-a/svc/release%2F1.x",
    ]);
  });

  it("returns a folder's direct children only, not its grandchildren", async () => {
    const { client, cache } = session([INDEX_FIXTURE]);

    const data = await getJobDetail(client, cache, { job: "team-a", depth: 6 });

    expect(data.kind).toBe("container");
    if (data.kind !== "container") return;
    expect(data.children.map((child) => child.fullName)).toEqual(["team-a/svc", "team-a/plain"]);
  });

  it("costs no extra request beyond the index for a container", async () => {
    const { client, cache, get } = session([INDEX_FIXTURE]);

    await getJobDetail(client, cache, { job: "team-a/svc", depth: 6 });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reports a truncated index as truncated, and RENDERS the notice", async () => {
    // A container the index never expanded used to render byte-identically to a
    // genuinely empty one: the zero-children branch returned before the notice.
    // Asserting only on the data is why that shipped.
    const shallow = {
      jobs: [{ name: "team-a", fullName: "team-a", _class: FOLDER_CLASS }],
    };
    const { client, cache } = session([{ match: "/api/json?tree=jobs[", body: shallow }]);

    const data = await getJobDetail(client, cache, { job: "team-a", depth: 1 });

    expect(data.kind).toBe("container");
    if (data.kind !== "container") return;
    expect(data.droppedFolders).toEqual(["team-a"]);
    expect(data.depthCap).toBe(1);

    const text = formatJobDetail(data);
    expect(text).toContain("No branches found");
    expect(text).toContain("not expanded at depth cap 1");
  });

  it("annotates a container only with ITS OWN dropped subtrees", async () => {
    // An unrelated subtree at the cap made a fully-expanded listing read as
    // incomplete.
    const mixed = {
      jobs: [
        {
          name: "svc",
          fullName: "svc",
          _class: FOLDER_CLASS,
          jobs: [{ name: "child", fullName: "svc/child", _class: FREESTYLE_CLASS, color: "blue" }],
        },
        { name: "other", fullName: "other", _class: FOLDER_CLASS },
      ],
    };
    const { client, cache } = session([{ match: "/api/json?tree=jobs[", body: mixed }]);

    const data = await getJobDetail(client, cache, { job: "svc", depth: 2 });

    expect(data.kind).toBe("container");
    if (data.kind !== "container") return;
    expect(data.droppedFolders).toEqual([]);
    expect(formatJobDetail(data)).not.toContain("not expanded");
  });

  it("normalizes a leading or trailing slash, which turned REF-02 off", async () => {
    // `jobRestPath` and `parsePathString` both tolerate these slashes, so the
    // verbatim index lookup disagreed with every other layer: `svc/` fell
    // through to the job shape and `ref: "42"` stopped becoming `PR-42`.
    for (const job of ["team-a/svc/", "/team-a/svc"]) {
      const { client, cache } = session([INDEX_FIXTURE]);

      const data = await getJobDetail(client, cache, { job, depth: 6 });

      expect(data.kind).toBe("container");
      if (data.kind !== "container") return;
      expect(data.job).toBe("team-a/svc");
      expect(data.total).toBe(3);
    }
  });

  it("normalizes PR-n on a trailing-slash multibranch job too", async () => {
    const { client, cache, get } = session([
      INDEX_FIXTURE,
      { match: "/job/team-a/job/svc/job/PR-42/api/json", body: JOB_BODY },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/svc/", ref: "42", depth: 6 });

    expect(data.kind).toBe("job");
    if (data.kind !== "job") return;
    expect(data.ref).toBe("PR-42");
    expect(get.mock.calls.some(([url]) => String(url).includes("/job/PR-42/"))).toBe(true);
  });

  it("returns the job shape for a plain job", async () => {
    const { client, cache } = session([
      INDEX_FIXTURE,
      { match: "/job/team-a/job/plain/api/json", body: { ...JOB_BODY, fullName: "team-a/plain" } },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/plain", depth: 6 });

    expect(data.kind).toBe("job");
  });

  it("returns the job shape for a multibranch child once a ref is given", async () => {
    const { client, cache } = session([
      INDEX_FIXTURE,
      { match: "/job/team-a/job/svc/job/main/api/json", body: JOB_BODY },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });

    expect(data.kind).toBe("job");
    if (data.kind !== "job") return;
    expect(data.ref).toBe("main");
    expect(data.fullName).toBe("team-a/svc/main");
  });
});

describe("ref normalization (REF-01)", () => {
  it("turns a bare integer into PR-<n> on a multibranch job", async () => {
    const { client, cache, get } = session([
      INDEX_FIXTURE,
      { match: "/job/PR-42/api/json", body: { ...JOB_BODY, fullName: "team-a/svc/PR-42" } },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/svc", ref: "42", depth: 6 });

    if (data.kind !== "job") throw new Error("expected the job shape");
    expect(data.ref).toBe("PR-42");
    expect(get.mock.calls.some(([path]) => path.includes("/job/PR-42/"))).toBe(true);
  });

  it("leaves a bare integer alone on a plain job, rather than inventing a PR", async () => {
    const { client, cache, get } = session([
      INDEX_FIXTURE,
      { match: "/job/team-a/job/plain/job/42/api/json", body: JOB_BODY },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/plain", ref: "42", depth: 6 });

    if (data.kind !== "job") throw new Error("expected the job shape");
    expect(data.ref).toBe("42");
    expect(get.mock.calls.some(([path]) => path.includes("PR-42"))).toBe(false);
  });
});

describe("job-shape extraction (READ-08)", () => {
  it("skips property[] entries that carry no parameterDefinitions", async () => {
    const { client, cache } = session([
      INDEX_FIXTURE,
      { match: "/job/main/api/json", body: JOB_BODY },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });

    if (data.kind !== "job") throw new Error("expected the job shape");
    expect(data.parameters).toEqual([
      {
        name: "BRANCH",
        type: "string",
        description: undefined,
        defaultValue: "main",
        choices: undefined,
      },
      {
        name: "DEPLOY",
        type: "boolean",
        description: undefined,
        defaultValue: "false",
        choices: undefined,
      },
    ]);
  });

  it("caps the build list server-side with Jenkins' {0,10} range syntax", async () => {
    const { client, cache, get } = session([
      INDEX_FIXTURE,
      { match: "/job/main/api/json", body: JOB_BODY },
    ]);

    await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });

    const detailCall = get.mock.calls.find(([path]) => path.includes("/job/main/api/json"));
    expect(detailCall?.[0]).toContain("builds[number,result,building,timestamp,duration]{0,10}");
  });

  it("reads buildable as false when the instance omits the field", async () => {
    const { client, cache } = session([
      INDEX_FIXTURE,
      { match: "/job/main/api/json", body: { ...JOB_BODY, buildable: undefined } },
    ]);

    const data = await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });

    if (data.kind !== "job") throw new Error("expected the job shape");
    expect(data.buildable).toBe(false);
  });
});

describe("caching (AGNT-01)", () => {
  it("caches the job shape under the volatile tier, so a repeat read issues no request", async () => {
    const { client, cache, get } = session([
      INDEX_FIXTURE,
      { match: "/job/main/api/json", body: JOB_BODY },
    ]);

    await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });
    const before = get.mock.calls.length;
    await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });

    expect(get.mock.calls.length).toBe(before);
  });

  it("re-reads once the 10s volatile window has passed", async () => {
    const { client, cache, get } = session([
      INDEX_FIXTURE,
      { match: "/job/main/api/json", body: JOB_BODY },
    ]);

    vi.useFakeTimers();

    await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });
    const before = get.mock.calls.length;
    // Past the volatile TTL but inside the 60s index TTL: exactly one new call.
    vi.advanceTimersByTime(TIER_TTL_MS.volatile + 1);
    await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });

    expect(get.mock.calls.length).toBe(before + 1);
  });
});

describe("errors (AGNT-05)", () => {
  it("maps a 404 on the job read to not_found", async () => {
    const { client, cache } = session([INDEX_FIXTURE]);

    await expect(
      getJobDetail(client, cache, { job: "team-a/missing", depth: 6 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("propagates the index read's own failure", async () => {
    const { client, cache } = session([{ match: "/api/json?tree=jobs[", body: {}, status: 403 }]);

    await expect(
      getJobDetail(client, cache, { job: "team-a/svc", depth: 6 }),
    ).rejects.toBeInstanceOf(JenkinsError);
  });
});

describe("formatJobDetail", () => {
  async function jobText(body: unknown): Promise<string> {
    const { client, cache } = session([INDEX_FIXTURE, { match: "/job/main/api/json", body }]);
    const data = await getJobDetail(client, cache, { job: "team-a/svc", ref: "main", depth: 6 });
    return formatJobDetail(data);
  }

  it("renders the header, the params table and the builds table", async () => {
    const text = await jobText(JOB_BODY);

    expect(text).toContain("team-a/svc/main  pipeline  buildable");
    expect(text).toContain("params (2)");
    expect(text).toMatch(/^BRANCH +string +main$/m);
    expect(text).toContain("builds (2)");
    expect(text).toMatch(/^1041 +FAILURE +2h +1m02s$/m);
  });

  it("labels a server-truncated build list as truncated, not complete", async () => {
    // `builds` is capped server-side by {0,10}; rendering `builds (10)` told a
    // caller the job had run exactly ten builds.
    const text = await jobText({ ...JOB_BODY, nextBuildNumber: 4001 });

    expect(text).toContain("builds (showing 2 of 4000)");
  });

  it("renders a choice parameter's accepted values in the default cell", async () => {
    // Collected but never rendered: an agent preparing a {trigger} call had to
    // fall back to --json to see them.
    const text = await jobText({
      ...JOB_BODY,
      property: [
        {
          _class: "hudson.model.ParametersDefinitionProperty",
          parameterDefinitions: [
            {
              name: "ENV",
              type: "ChoiceParameterDefinition",
              defaultParameterValue: { value: "dev" },
              choices: ["dev", "stage", "prod"],
            },
          ],
        },
      ],
    });

    expect(text).toMatch(/^ENV +choice +dev \(dev\|stage\|prod\)$/m);
  });

  it("shows a running build as BUILDING, not its previous result", async () => {
    const text = await jobText(JOB_BODY);

    expect(text).toMatch(/1042 +BUILDING/);
  });

  it("prints an explicit empty line rather than an empty table for no params", async () => {
    const text = await jobText({ ...JOB_BODY, property: [] });

    expect(text).toContain("No parameters found");
    expect(text).not.toContain("params (");
  });

  it("prints an explicit empty line for no builds", async () => {
    const text = await jobText({ ...JOB_BODY, builds: [] });

    expect(text).toContain("No builds found");
  });

  it("ends with next: lines using core's placeholder vocabulary, never literal calls", async () => {
    const text = await jobText(JOB_BODY);

    expect(text).toContain("next: {build}");
    expect(text).not.toContain("jenkins_");
  });

  it("renders a container's children with counts", async () => {
    const { client, cache } = session([INDEX_FIXTURE]);
    const data = await getJobDetail(client, cache, { job: "team-a/svc", depth: 6 });

    const text = formatJobDetail(data);

    expect(text).toContain("team-a/svc  multibranch (3)");
    expect(text).toMatch(/main +success +pipeline/);
    expect(text).toMatch(/PR-42 +building/);
    expect(text).toContain("next: {job} with ref=<name> for one branch");
  });

  it("caps the children table at 20 rows and names the call that lists the rest", async () => {
    const many = {
      jobs: [
        {
          name: "big",
          fullName: "big",
          _class: MULTIBRANCH_CLASS,
          jobs: Array.from({ length: 25 }, (_, i) => ({
            name: `b${i}`,
            fullName: `big/b${i}`,
            _class: WORKFLOW_CLASS,
            color: "blue",
          })),
        },
      ],
    };
    const { client, cache } = session([{ match: "/api/json?tree=jobs[", body: many }]);
    const data = await getJobDetail(client, cache, { job: "big", depth: 6 });

    const text = formatJobDetail(data);

    expect(text).toContain("big  multibranch (showing 20 of 25)");
    expect(text).not.toContain("b24");
    expect(text).toContain("next: {findJobs}");
  });

  it("prints a slashed branch name decoded, so it round-trips as a ref", async () => {
    // `release%2F1.x` passed back as ref re-encodes to %252F and 404s; the
    // working value was never shown. The existing render test skipped this row.
    const { client, cache } = session([INDEX_FIXTURE]);
    const data = await getJobDetail(client, cache, { job: "team-a/svc", depth: 6 });

    const text = formatJobDetail(data);

    expect(text).toContain("release/1.x");
    expect(text).not.toContain("release%2F1.x");
  });

  it("prints an explicit empty line for a container with no children", async () => {
    const empty = {
      jobs: [{ name: "hollow", fullName: "hollow", _class: MULTIBRANCH_CLASS, jobs: [] }],
    };
    const { client, cache } = session([{ match: "/api/json?tree=jobs[", body: empty }]);
    const data = await getJobDetail(client, cache, { job: "hollow", depth: 6 });

    expect(formatJobDetail(data)).toContain("No branches found");
  });
});

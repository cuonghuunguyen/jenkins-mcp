/**
 * `triggerBuild` parameter validation, `rebuildFrom` and `wait` (CTRL-07).
 *
 * The point of the validation half is that it happens BEFORE the POST, so
 * every rejection case asserts that nothing was written.
 */

import { describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { formatTriggerResult } from "../format/build.js";
import { triggerBuild } from "../operations/trigger.js";

interface PostCall {
  path: string;
  params: Record<string, string>;
}

const CHOICE_JOB = [
  {
    parameterDefinitions: [
      {
        name: "BRANCH",
        type: "StringParameterDefinition",
        defaultParameterValue: { value: "main" },
      },
      { name: "ENV", type: "ChoiceParameterDefinition", choices: ["dev", "prod"] },
      { name: "TICKET", type: "StringParameterDefinition" },
    ],
  },
];

/**
 * A client covering the four GETs a trigger can make (job parameters, a past
 * build's parameters, the queue item, and a wait poll) plus the trigger POST.
 */
function mockClient(options: {
  definitions?: unknown[];
  pastParams?: Array<{ name: string; value: string }>;
  queue?: Record<string, unknown>;
  buildState?: Record<string, unknown>;
}) {
  const posts: PostCall[] = [];
  const gets: string[] = [];

  const get = vi.fn(async (path: string) => {
    gets.push(path);
    if (path.includes("tree=property")) {
      return new Response(JSON.stringify({ property: options.definitions ?? CHOICE_JOB }), {
        status: 200,
      });
    }
    if (path.includes("tree=actions[parameters")) {
      return new Response(
        JSON.stringify({ actions: [{}, { parameters: options.pastParams ?? [] }] }),
        {
          status: 200,
        },
      );
    }
    if (path.includes("/queue/item/")) {
      return new Response(
        JSON.stringify(
          options.queue ?? { executable: { number: 7, url: "https://jenkins.example.com/7/" } },
        ),
        { status: 200 },
      );
    }
    if (path.includes("tree=number,result,building")) {
      return new Response(
        JSON.stringify(
          options.buildState ?? { number: 7, result: "SUCCESS", building: false, duration: 1000 },
        ),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const post = vi.fn(async (path: string, init?: { body?: URLSearchParams }) => {
    posts.push({
      path,
      params: Object.fromEntries(init?.body === undefined ? [] : init.body.entries()),
    });
    return new Response(null, {
      status: 201,
      headers: { Location: "https://jenkins.example.com/queue/item/101/" },
    });
  });

  return {
    client: { get, post, baseUrl: "https://jenkins.example.com" } as unknown as JenkinsClient,
    posts,
    gets,
    get,
  };
}

describe("trigger parameter validation (CTRL-07)", () => {
  it("rejects an unknown parameter name and names the ones the job declares", async () => {
    const { client, posts } = mockClient({});

    await expect(
      triggerBuild(client, new JenkinsCache(), { job: "svc", params: { BRACNH: "main" } }),
    ).rejects.toThrowError(/Unknown build parameter 'BRACNH'/);

    expect(posts).toEqual([]);
  });

  it("rejects a value outside a choice parameter's choices, listing them", async () => {
    const { client, posts } = mockClient({});

    await expect(
      triggerBuild(client, new JenkinsCache(), { job: "svc", params: { ENV: "staging" } }),
    ).rejects.toThrowError(/Allowed: dev, prod/);

    expect(posts).toEqual([]);
  });

  it("rejects params passed to a job that declares none", async () => {
    const { client, posts } = mockClient({ definitions: [] });

    await expect(
      triggerBuild(client, new JenkinsCache(), { job: "svc", params: { ENV: "dev" } }),
    ).rejects.toThrowError(/declares no build parameters/);

    expect(posts).toEqual([]);
  });

  it("reports - but does not reject - a declared parameter with no default that was omitted", async () => {
    const { client, posts } = mockClient({});

    const result = await triggerBuild(client, new JenkinsCache(), {
      job: "svc",
      params: { ENV: "dev" },
    });

    expect(result.missingDefaults).toEqual(["TICKET"]);
    expect(posts[0]?.path).toBe("/job/svc/buildWithParameters");
    expect(formatTriggerResult(result)).toContain("warning: not supplied and no default");
  });

  it("posts /build with no params, and RE-reads the definitions after each trigger", async () => {
    const { client, posts, gets } = mockClient({ definitions: [] });
    const cache = new JenkinsCache();

    await triggerBuild(client, cache, { job: "svc" });
    await triggerBuild(client, cache, { job: "svc" });

    expect(posts.map((call) => call.path)).toEqual(["/job/svc/build", "/job/svc/build"]);
    // The old name said "caches the definitions across triggers" while
    // asserting they were fetched TWICE - a trigger invalidates the job's
    // cache, so the second read necessarily re-fetches. The caching this test
    // was named for is asserted in regressions.test.ts, where no trigger runs
    // in between.
    expect(gets.filter((path) => path.includes("tree=property")).length).toBe(2);
  });
});

describe("rebuild_from (CTRL-07)", () => {
  it("inherits the old build's parameters and lets explicit params override them", async () => {
    const { client, posts } = mockClient({
      pastParams: [
        { name: "BRANCH", value: "release" },
        { name: "ENV", value: "prod" },
      ],
    });

    const result = await triggerBuild(client, new JenkinsCache(), {
      job: "svc",
      rebuildFrom: 5,
      params: { ENV: "dev" },
    });

    expect(posts[0]?.params).toEqual({ BRANCH: "release", ENV: "dev" });
    expect(result.params).toEqual({ BRANCH: "release", ENV: "dev" });
    expect(result.inherited).toEqual(["BRANCH"]);
    expect(formatTriggerResult(result)).toContain("inherited: BRANCH");
  });

  it("still rejects an inherited parameter the job no longer declares, blaming the rebuild", async () => {
    const { client, posts } = mockClient({ pastParams: [{ name: "LEGACY", value: "1" }] });

    // The caller never passed 'LEGACY' - `rebuild_from` did - so "Unknown
    // build parameter 'LEGACY'" accused them of a typo they never made.
    await expect(
      triggerBuild(client, new JenkinsCache(), { job: "svc", rebuildFrom: "lastBuild" }),
    ).rejects.toThrowError(/The build you rebuilt from ran with 'LEGACY'/);

    expect(posts).toEqual([]);
  });
});

describe("wait: true (CTRL-07)", () => {
  it("chains the wait and returns the finished state", async () => {
    const { client } = mockClient({ definitions: [] });

    const result = await triggerBuild(client, new JenkinsCache(), { job: "svc", wait: true });

    expect(result).toMatchObject({ buildNumber: 7, building: false });
    expect("waited" in result && result.waited).toMatchObject({
      finished: true,
      result: "SUCCESS",
    });
    expect(formatTriggerResult(result)).toContain("status: SUCCESS");
  });

  it("does not wait on a queued result, which has no build number to wait on", async () => {
    const { client, get } = mockClient({ definitions: [], queue: { why: "Waiting for executor" } });

    const result = await triggerBuild(client, new JenkinsCache(), {
      job: "svc",
      wait: true,
      timeout: 0,
    });

    expect(result).toMatchObject({ queued: true, queueId: "101" });
    expect("buildNumber" in result).toBe(false);
    expect(get.mock.calls.some(([path]) => path.includes("tree=number,result,building"))).toBe(
      false,
    );
  });
});

/**
 * Vitest coverage for the Jenkins-mirroring in-memory VFS (D-01, D-03..D-09).
 * `JenkinsClient.get()` is mocked with fixture JSON throughout — this suite
 * never hits a live Jenkins instance, matching the project's established
 * fixture/mocked-client test convention.
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "./client.js";
import { buildJenkinsVfs, MORE_BELOW_DEPTH_LIMIT_MARKER, SKELETON_DEPTH } from "./vfs.js";

/** Builds a mocked `JenkinsClient` whose `get()` is driven by `handlers` (URL substring -> JSON body or Response). */
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

/** Skeleton fixture: a folder containing a freestyle job, and a multibranch job containing one branch. */
const BASIC_SKELETON = {
  jobs: [
    {
      name: "team-a",
      _class: "com.cloudbees.hudson.plugins.folder.Folder",
      jobs: [
        {
          name: "freestyle-job",
          _class: "hudson.model.FreeStyleProject",
          builds: [{ number: 1 }],
        },
      ],
    },
    {
      name: "my-multibranch",
      _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
      jobs: [
        {
          name: "feature%2Ffoo",
          _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
          builds: [{ number: 5 }],
        },
      ],
    },
  ],
};

describe("buildJenkinsVfs — Task 1: skeleton builder", () => {
  it("materializes the directory shape for a folder->job and a multibranch->branch nesting (READ-01)", async () => {
    const { client } = createMockClient({ "/api/json": BASIC_SKELETON });
    const fs = await buildJenkinsVfs(client);

    // Shallow readdir of /jobs shows only top-level names — no eager crawl.
    const topLevel = await fs.readdir("/jobs");
    expect(topLevel.sort()).toEqual(["my-multibranch", "team-a"]);

    // Folder -> job nests as a real directory.
    expect(await fs.exists("/jobs/team-a/freestyle-job/api.json")).toBe(true);

    // Multibranch -> branch nests as a real directory.
    const branchDir = await fs.readdir("/jobs/my-multibranch");
    expect(branchDir).toContain("feature%2Ffoo");
    expect(await fs.exists("/jobs/my-multibranch/feature%2Ffoo/api.json")).toBe(true);
  });

  it("translates a multibranch branch segment to a REST path via jobPath(parsePathString(...)), preserving %2F (READ-01)", async () => {
    const { client, get } = createMockClient({
      "/api/json": BASIC_SKELETON,
      "/job/my-multibranch/job/feature%2Ffoo/api/json": { name: "feature%2Ffoo" },
    });
    const fs = await buildJenkinsVfs(client);
    get.mockClear();

    await fs.readFile("/jobs/my-multibranch/feature%2Ffoo/api.json");

    expect(get).toHaveBeenCalledTimes(1);
    const url = get.mock.calls[0]?.[0] as string;
    // Matches jobPath(parsePathString("my-multibranch/feature%2Ffoo")) exactly —
    // never a hand-joined string, and %2F is never re-encoded to %252F.
    expect(url).toContain("/job/my-multibranch/job/feature%2Ffoo/api/json");
    expect(url).not.toContain("%252F");
  });

  it("issues exactly one client.get call for the skeleton phase; permalink alias directories exist without a known build number", async () => {
    const { client, get } = createMockClient({ "/api/json": BASIC_SKELETON });
    const fs = await buildJenkinsVfs(client);

    expect(get).toHaveBeenCalledTimes(1);

    const buildsDir = await fs.readdir("/jobs/team-a/freestyle-job/builds");
    expect(buildsDir.sort()).toEqual(
      ["1", "lastBuild", "lastCompletedBuild", "lastFailedBuild", "lastSuccessfulBuild"].sort(),
    );
  });

  it("materializes a .more-below-depth-limit marker instead of silently dropping a subtree beyond SKELETON_DEPTH (Pitfall 4, T-02-05)", async () => {
    // Four nested folders (f1..f4), where f4 still exposes a non-empty
    // `jobs` field the depth-bounded fetch could not recurse into.
    const deepSkeleton = {
      jobs: [
        {
          name: "f1",
          _class: "com.cloudbees.hudson.plugins.folder.Folder",
          jobs: [
            {
              name: "f2",
              _class: "com.cloudbees.hudson.plugins.folder.Folder",
              jobs: [
                {
                  name: "f3",
                  _class: "com.cloudbees.hudson.plugins.folder.Folder",
                  jobs: [
                    {
                      name: "f4",
                      _class: "com.cloudbees.hudson.plugins.folder.Folder",
                      jobs: [{ name: "hidden-child", _class: "hudson.model.FreeStyleProject" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(SKELETON_DEPTH).toBe(4);

    const { client } = createMockClient({ "/api/json": deepSkeleton });
    const fs = await buildJenkinsVfs(client);

    const markerPath = `/jobs/f1/f2/f3/f4/${MORE_BELOW_DEPTH_LIMIT_MARKER}`;
    expect(await fs.exists(markerPath)).toBe(true);
    // The hidden subtree itself was never materialized.
    expect(await fs.exists("/jobs/f1/f2/f3/f4/hidden-child")).toBe(false);
  });
});

describe("buildJenkinsVfs — Task 2: lazy content providers", () => {
  it("fetches job api.json with the curated tree= projection on first read only, and caches thereafter (READ-02, D-05/D-09)", async () => {
    const { client, get } = createMockClient({
      "/api/json": BASIC_SKELETON,
      "/job/team-a/job/freestyle-job/api/json": { name: "freestyle-job", buildable: true },
    });
    const fs = await buildJenkinsVfs(client);
    get.mockClear();

    const first = await fs.readFile("/jobs/team-a/freestyle-job/api.json");
    expect(get).toHaveBeenCalledTimes(1);
    const url = get.mock.calls[0]?.[0] as string;
    expect(url).toContain("/job/team-a/job/freestyle-job/api/json?tree=");
    expect(JSON.parse(first)).toEqual({ name: "freestyle-job", buildable: true });

    const second = await fs.readFile("/jobs/team-a/freestyle-job/api.json");
    expect(get).toHaveBeenCalledTimes(1); // no re-fetch on second read
    expect(second).toBe(first);
  });

  it("fetches build api.json with the curated build tree= projection (READ-03)", async () => {
    const { client, get } = createMockClient({
      "/api/json": BASIC_SKELETON,
      "/job/team-a/job/freestyle-job/1/api/json": { number: 1, result: "SUCCESS", building: false },
    });
    const fs = await buildJenkinsVfs(client);
    get.mockClear();

    const body = await fs.readFile("/jobs/team-a/freestyle-job/builds/1/api.json");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0] as string).toContain(
      "/job/team-a/job/freestyle-job/1/api/json?tree=",
    );
    expect(JSON.parse(body)).toEqual({ number: 1, result: "SUCCESS", building: false });
  });

  it("fetches the whole console log once, with no tree= applied (READ-04, D-05)", async () => {
    const { client, get } = createMockClient({
      "/api/json": BASIC_SKELETON,
      "/job/team-a/job/freestyle-job/1/consoleText": "line1\nline2\nERROR: boom\n",
    });
    const fs = await buildJenkinsVfs(client);
    get.mockClear();

    const log = await fs.readFile("/jobs/team-a/freestyle-job/builds/1/log");
    expect(get).toHaveBeenCalledTimes(1);
    const url = get.mock.calls[0]?.[0] as string;
    expect(url).toBe("/job/team-a/job/freestyle-job/1/consoleText");
    expect(url).not.toContain("tree=");
    expect(log).toBe("line1\nline2\nERROR: boom\n");
  });

  it("registers wfapi.json for pipeline jobs (passthrough + graceful 404), and no wfapi.json at all for freestyle jobs (READ-05, Pitfall 2)", async () => {
    const { client, get } = createMockClient({
      "/api/json": BASIC_SKELETON,
      "/job/my-multibranch/job/feature%2Ffoo/5/wfapi/describe": {
        id: "5",
        status: "SUCCESS",
        stages: [],
      },
    });
    const fs = await buildJenkinsVfs(client);

    // Freestyle job: no wfapi.json entry at all.
    expect(await fs.exists("/jobs/team-a/freestyle-job/builds/1/wfapi.json")).toBe(false);

    // Pipeline job: passthrough JSON.
    const wfapiBody = await fs.readFile("/jobs/my-multibranch/feature%2Ffoo/builds/5/wfapi.json");
    expect(JSON.parse(wfapiBody)).toEqual({ id: "5", status: "SUCCESS", stages: [] });

    // Pipeline job, 404 on wfapi/describe (e.g. never actually run through the
    // pipeline stage view) -> explanatory note, not a throw.
    get.mockClear();
    get.mockImplementationOnce(async () => new Response("not found", { status: 404 }));
    const notePath = "/jobs/my-multibranch/feature%2Ffoo/builds/lastBuild/wfapi.json";
    const note = await fs.readFile(notePath);
    expect(JSON.parse(note)).toEqual({ _note: "wfapi not available for this job" });
  });

  it("fetches the queue with the curated tree= projection (READ-06)", async () => {
    const { client, get } = createMockClient({
      "/api/json": BASIC_SKELETON,
      "/queue/api/json": { items: [{ id: 1, why: "waiting", blocked: false, buildable: true }] },
    });
    const fs = await buildJenkinsVfs(client);
    get.mockClear();

    const body = await fs.readFile("/queue.json");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0] as string).toContain("/queue/api/json?tree=");
    expect(JSON.parse(body)).toEqual({
      items: [{ id: 1, why: "waiting", blocked: false, buildable: true }],
    });
  });

  it("throws a normalized, secret-free JenkinsError on a non-ok response and never calls client.post (Pitfall 5, T-02-03/T-02-06)", async () => {
    const fakeToken = "sk-fake-secret-token-12345";
    const fakeCookie = "JSESSIONID.abc=deadbeef";
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/api/json"))
        return new Response(JSON.stringify(BASIC_SKELETON), { status: 200 });
      return new Response(`leaked ${fakeToken} ${fakeCookie}`, { status: 500 });
    });
    const post = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = { get, post } as unknown as JenkinsClient;

    const fs = await buildJenkinsVfs(client);

    await expect(fs.readFile("/jobs/team-a/freestyle-job/api.json")).rejects.toMatchObject({
      name: "JenkinsError",
    });

    let caughtMessage = "";
    try {
      await fs.readFile("/jobs/team-a/freestyle-job/api.json");
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).not.toContain(fakeToken);
    expect(caughtMessage).not.toContain(fakeCookie);
    expect(post).not.toHaveBeenCalled();
  });
});

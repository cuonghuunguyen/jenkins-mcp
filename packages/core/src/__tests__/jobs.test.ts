import { describe, expect, it } from "vitest";
import { JenkinsCache } from "../cache.js";
import { formatJobIndex } from "../format/jobs.js";
import {
  buildIndexTreeQuery,
  isContainerClass,
  isMultibranchJob,
  jobStatusOf,
  jobTypeOf,
  loadJobIndex,
} from "../operations/jobs.js";
import {
  createMockClient,
  FOLDER_CLASS,
  FREESTYLE_CLASS,
  MULTIBRANCH_CLASS,
  NESTED_INDEX,
  WORKFLOW_CLASS,
} from "./fixtures.js";

describe("buildIndexTreeQuery", () => {
  it("nests one jobs[...] level per requested depth", () => {
    expect(buildIndexTreeQuery(1)).toBe(
      "jobs[fullName,name,color,_class,url,scm[userRemoteConfigs[url]]," +
        "lastBuild[number,timestamp,result]]",
    );

    const depth3 = buildIndexTreeQuery(3);
    // Three levels means the leaf field list appears three times, and the
    // deepest level carries no further jobs[...] sub-selector.
    expect(depth3.split("fullName").length - 1).toBe(3);
    // `lastBuild[` is not a nesting level, so it is excluded from the count.
    expect(depth3.split(/(?<!last)(?<!Build)jobs\[/).length - 1).toBe(3);
  });

  it("asks for the SCM remote URL, which is what makes git-remote lookup possible", () => {
    expect(buildIndexTreeQuery(2)).toContain("scm[userRemoteConfigs[url]]");
  });
});

describe("class and colour classification", () => {
  it("treats folders, organization folders and multibranch projects as containers", () => {
    expect(isContainerClass(FOLDER_CLASS)).toBe(true);
    expect(isContainerClass(MULTIBRANCH_CLASS)).toBe(true);
    expect(isContainerClass(FREESTYLE_CLASS)).toBe(false);
    expect(isContainerClass(WORKFLOW_CLASS)).toBe(false);
    expect(isContainerClass(undefined)).toBe(false);
  });

  it("classifies a multibranch project as multibranch, not as a plain folder", () => {
    // MULTIBRANCH_CLASS contains neither "Folder" nor a misleading substring,
    // but the ordering in jobTypeOf still matters for organization folders.
    expect(jobTypeOf(MULTIBRANCH_CLASS)).toBe("multibranch");
    expect(jobTypeOf(FOLDER_CLASS)).toBe("folder");
    expect(jobTypeOf(WORKFLOW_CLASS)).toBe("pipeline");
    expect(jobTypeOf(FREESTYLE_CLASS)).toBe("freestyle");
    expect(jobTypeOf("some.unknown.Plugin")).toBe("other");
  });

  it("reports a running job as building rather than as its previous result", () => {
    // Jenkins keeps the previous result's colour and appends _anime while
    // building, so checking the suffix first is what stops a running job from
    // being reported as already successful.
    expect(jobStatusOf("blue_anime")).toBe("building");
    expect(jobStatusOf("red_anime")).toBe("building");
    expect(jobStatusOf("blue")).toBe("success");
    expect(jobStatusOf("red")).toBe("failed");
    expect(jobStatusOf("yellow")).toBe("unstable");
    expect(jobStatusOf("disabled")).toBe("disabled");
    expect(jobStatusOf("notbuilt")).toBe("not_built");
    expect(jobStatusOf(undefined)).toBe("unknown");
  });
});

describe("loadJobIndex", () => {
  const indexFixture = { match: "/api/json?tree=jobs[", body: NESTED_INDEX };

  it("materializes every folder, job, branch and PR in one request", async () => {
    const { client, get } = createMockClient([indexFixture]);
    const index = await loadJobIndex(client, new JenkinsCache(), 6);

    expect(get).toHaveBeenCalledTimes(1);
    expect(index.total).toBe(5);
    expect(index.jobs.map((job) => job.fullName)).toEqual([
      "team-a",
      "team-a/freestyle-job",
      "my-multibranch",
      "my-multibranch/feature%2Ffoo",
      "my-multibranch/PR-42",
    ]);
  });

  it("records the depth each entry was found at, and its SCM remote URLs", async () => {
    const { client } = createMockClient([indexFixture]);
    const index = await loadJobIndex(client, new JenkinsCache(), 6);

    const freestyle = index.jobs.find((job) => job.fullName === "team-a/freestyle-job");
    expect(freestyle?.depth).toBe(2);
    expect(freestyle?.scmUrls).toEqual(["ssh://git@bitbucket.example.com/team/svc.git"]);

    const folder = index.jobs.find((job) => job.fullName === "team-a");
    expect(folder?.depth).toBe(1);
    expect(folder?.scmUrls).toEqual([]);
  });

  it("reports a container that sits at the depth cap instead of treating it as a leaf", async () => {
    // At the deepest requested level Jenkins simply omits `jobs`, which is
    // indistinguishable from a leaf job - so an unexpanded container must be
    // reported, or the index reads as complete when it is not.
    const { client } = createMockClient([
      {
        match: "/api/json?tree=jobs[",
        body: { jobs: [{ fullName: "team-a", name: "team-a", _class: FOLDER_CLASS }] },
      },
    ]);

    const index = await loadJobIndex(client, new JenkinsCache(), 1);

    expect(index.droppedFolders).toEqual(["team-a"]);
    expect(formatJobIndex(index)).toContain("not expanded at depth cap 1");
  });

  it("does not report an empty folder below the cap as dropped", async () => {
    const { client } = createMockClient([
      {
        match: "/api/json?tree=jobs[",
        body: {
          jobs: [{ fullName: "team-a", name: "team-a", _class: FOLDER_CLASS, jobs: [] }],
        },
      },
    ]);

    const index = await loadJobIndex(client, new JenkinsCache(), 6);

    expect(index.droppedFolders).toEqual([]);
  });

  it("caches the index, so a second call issues no request", async () => {
    const { client, get } = createMockClient([indexFixture]);
    const cache = new JenkinsCache();

    await loadJobIndex(client, cache, 6);
    await loadJobIndex(client, cache, 6);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("throws a redacted JenkinsError when the index request fails", async () => {
    const { client } = createMockClient([{ match: "/api/json?tree=jobs[", body: {}, status: 403 }]);

    await expect(loadJobIndex(client, new JenkinsCache(), 6)).rejects.toMatchObject({
      name: "JenkinsError",
      code: "forbidden",
    });
  });

  it("identifies a multibranch parent, which is what turns a bare integer ref into PR-<n>", async () => {
    const { client } = createMockClient([indexFixture]);
    const index = await loadJobIndex(client, new JenkinsCache(), 6);

    expect(isMultibranchJob(index, "my-multibranch")).toBe(true);
    expect(isMultibranchJob(index, "team-a")).toBe(false);
    expect(isMultibranchJob(index, "team-a/freestyle-job")).toBe(false);
    expect(isMultibranchJob(index, "does-not-exist")).toBe(false);
  });
});

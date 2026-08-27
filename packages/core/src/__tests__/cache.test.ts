import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKey, JenkinsCache, jobKey, TIER_TTL_MS } from "../cache.js";
import { getBuild } from "../operations/build.js";
import { createMockClient } from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("JenkinsCache", () => {
  it("serves a second read of the same key from cache without re-running the loader", async () => {
    const cache = new JenkinsCache();
    const loader = vi.fn(async () => "value");

    expect(await cache.fetch("k", loader, "index")).toBe("value");
    expect(await cache.fetch("k", loader, "index")).toBe("value");

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.loadCount()).toBe(1);
  });

  it("re-runs the loader once a volatile entry's 10s TTL has elapsed", async () => {
    vi.useFakeTimers();
    const cache = new JenkinsCache();
    const loader = vi.fn(async () => "value");

    await cache.fetch("k", loader, "volatile");
    vi.advanceTimersByTime(TIER_TTL_MS.volatile + 1);
    await cache.fetch("k", loader, "volatile");

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("never expires a permanent entry", async () => {
    vi.useFakeTimers();
    const cache = new JenkinsCache();
    const loader = vi.fn(async () => "value");

    await cache.fetch("k", loader, "permanent");
    // Well past any plausible session length.
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
    await cache.fetch("k", loader, "permanent");

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("picks the tier from the loaded value, not from the key", async () => {
    vi.useFakeTimers();
    const cache = new JenkinsCache();
    const running = vi.fn(async () => ({ building: true }));

    await cache.fetch("k", running, (value) => (value.building ? "volatile" : "permanent"));
    vi.advanceTimersByTime(TIER_TTL_MS.volatile + 1);
    await cache.fetch("k", running, (value) => (value.building ? "volatile" : "permanent"));

    expect(running).toHaveBeenCalledTimes(2);
  });

  it("invalidateJob drops every entry for that job across refs and builds, and no others", async () => {
    const cache = new JenkinsCache();
    const loader = vi.fn(async () => "value");

    await cache.fetch(jobKey("team/svc", undefined, "summary"), loader, "permanent");
    await cache.fetch(jobKey("team/svc", "main", "summary"), loader, "permanent");
    await cache.fetch(buildKey("team/svc", "main", 12, "summary"), loader, "permanent");
    await cache.fetch(jobKey("team/other", undefined, "summary"), loader, "permanent");
    expect(cache.size()).toBe(4);

    cache.invalidateJob("team/svc");

    expect(cache.size()).toBe(1);
    // The surviving entry is the untouched sibling job.
    expect(await cache.fetch(jobKey("team/other", undefined, "summary"), loader, "permanent")).toBe(
      "value",
    );
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("does not let one job's prefix match a longer job name that merely starts with it", async () => {
    const cache = new JenkinsCache();
    const loader = vi.fn(async () => "value");

    await cache.fetch(jobKey("team/svc", undefined, "summary"), loader, "permanent");
    await cache.fetch(jobKey("team/svc-two", undefined, "summary"), loader, "permanent");

    cache.invalidateJob("team/svc");

    expect(cache.size()).toBe(1);
  });
});

describe("getBuild caching (AGNT-01 criterion: zero REST requests on a repeat finished-build read)", () => {
  const finishedBuild = {
    match: "/job/team-a/job/svc/12/api/json",
    body: {
      number: 12,
      result: "FAILURE",
      building: false,
      duration: 94_000,
      timestamp: 1_700_000_000_000,
      url: "https://jenkins.example.com/job/team-a/job/svc/12/",
      actions: [{ causes: [{ shortDescription: "Started by user alice" }] }],
    },
  };

  it("issues exactly one REST request for two reads of the same finished build", async () => {
    const { client, get } = createMockClient([finishedBuild]);
    const cache = new JenkinsCache();

    const first = await getBuild(client, cache, { job: "team-a/svc", build: 12 });
    expect(get).toHaveBeenCalledTimes(1);

    const second = await getBuild(client, cache, { job: "team-a/svc", build: 12 });
    expect(get).toHaveBeenCalledTimes(1);

    expect(second).toEqual(first);
    expect(first.result).toBe("FAILURE");
    expect(first.building).toBe(false);
    expect(first.cause).toBe("Started by user alice");
  });

  it("re-requests a running build, whose state can still change", async () => {
    vi.useFakeTimers();
    const { client, get } = createMockClient([
      {
        match: "/job/team-a/job/svc/13/api/json",
        body: { number: 13, result: null, building: true },
      },
    ]);
    const cache = new JenkinsCache();

    await getBuild(client, cache, { job: "team-a/svc", build: 13 });
    vi.advanceTimersByTime(TIER_TTL_MS.volatile + 1);
    await getBuild(client, cache, { job: "team-a/svc", build: 13 });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps a permalink alias volatile even when it resolves to a finished build", async () => {
    vi.useFakeTimers();
    const { client, get } = createMockClient([
      {
        match: "/job/team-a/job/svc/lastBuild/api/json",
        body: { number: 12, result: "SUCCESS", building: false },
      },
    ]);
    const cache = new JenkinsCache();

    // A finished build cached forever is correct; `lastBuild` cached forever is
    // not, because the next trigger moves what the alias points at.
    await getBuild(client, cache, { job: "team-a/svc", build: "lastBuild" });
    vi.advanceTimersByTime(TIER_TTL_MS.volatile + 1);
    await getBuild(client, cache, { job: "team-a/svc", build: "lastBuild" });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("invalidating the job forces the next read of a finished build back to Jenkins", async () => {
    const { client, get } = createMockClient([finishedBuild]);
    const cache = new JenkinsCache();

    await getBuild(client, cache, { job: "team-a/svc", build: 12 });
    cache.invalidateJob("team-a/svc");
    await getBuild(client, cache, { job: "team-a/svc", build: 12 });

    expect(get).toHaveBeenCalledTimes(2);
  });
});

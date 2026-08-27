/**
 * Vitest coverage for `pollQueueItem` (CTRL-03 resolution half, D-04/D-04a).
 * `JenkinsClient.get()` is mocked with a call-count-driven fake Response
 * factory (mirroring `bash.test.ts`'s `createMockClient` style) so every
 * poll iteration is deterministic and no real waiting occurs — fake timers
 * drive the exponential backoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "../client.js";
import { pollQueueItem } from "../operations/queue.js";

interface JsonFixture {
  body: unknown;
  status: number;
}

/**
 * Builds a mocked `JenkinsClient` whose `get()` returns a fresh `Response`
 * per call, following `fixtures` in order and repeating the last fixture
 * once exhausted (a `Response` body can only be read once, so a NEW
 * `Response` must be constructed on every call rather than reusing one).
 */
function createSequencedMockClient(fixtures: JsonFixture[]): {
  client: JenkinsClient;
  get: ReturnType<typeof vi.fn>;
} {
  let callIndex = 0;
  const get = vi.fn(async () => {
    const fixture = fixtures[Math.min(callIndex, fixtures.length - 1)];
    callIndex += 1;
    return new Response(JSON.stringify(fixture.body), { status: fixture.status });
  });
  const post = vi.fn(async () => new Response("{}", { status: 200 }));
  return { client: { get, post } as unknown as JenkinsClient, get };
}

function jsonResponse(body: unknown, status = 200): JsonFixture {
  return { body, status };
}

describe("pollQueueItem", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves to buildNumber on the first poll when executable is already present", async () => {
    const { client } = createSequencedMockClient([
      jsonResponse({ executable: { number: 42, url: "http://jenkins/job/x/42/" } }),
    ]);

    const result = await pollQueueItem(client, "99", 15_000);

    expect(result).toEqual({
      resolved: true,
      buildNumber: 42,
      url: "http://jenkins/job/x/42/",
    });
  });

  it("resolves to buildNumber after backing off across several empty polls", async () => {
    const { client, get } = createSequencedMockClient([
      jsonResponse({ blocked: true, why: "waiting for executor" }),
      jsonResponse({ blocked: true, why: "waiting for executor" }),
      jsonResponse({ blocked: true, why: "waiting for executor" }),
      jsonResponse({ executable: { number: 7, url: "http://jenkins/job/x/7/" } }),
    ]);

    const resultPromise = pollQueueItem(client, "99", 15_000);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(1125);
    const result = await resultPromise;

    expect(result).toEqual({ resolved: true, buildNumber: 7, url: "http://jenkins/job/x/7/" });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("returns the unresolved cancelled branch without waiting for the full timeout", async () => {
    const { client } = createSequencedMockClient([
      jsonResponse({ cancelled: true, why: "Build was aborted" }),
    ]);

    const result = await pollQueueItem(client, "99", 15_000);

    expect(result).toEqual({ resolved: false, cancelled: true, why: "Build was aborted" });
  });

  it("returns the unresolved timeout branch once elapsed time >= timeoutMs, never hanging", async () => {
    const { client } = createSequencedMockClient([
      jsonResponse({ blocked: true, why: "still queued" }),
    ]);

    const resultPromise = pollQueueItem(client, "99", 1000);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(750);
    const result = await resultPromise;

    expect(result).toEqual({ resolved: false, cancelled: false, why: "still queued" });
  });

  it("throws normalizeError's JenkinsError when a poll response is non-ok", async () => {
    const { client } = createSequencedMockClient([jsonResponse({ error: "boom" }, 500)]);

    await expect(pollQueueItem(client, "99", 15_000)).rejects.toMatchObject({
      name: "JenkinsError",
      operation: "jenkins_trigger_build:queue-poll",
    });
  });
});

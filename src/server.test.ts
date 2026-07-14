/**
 * Structural safety-boundary tests for the v1 tool set (SAFE-01/SAFE-02,
 * criterion 5, D-08). These are the durable, assertion-backed guards that:
 *
 *  1. The registered tool-name set equals exactly the four locked tools —
 *     no create/update/delete tool exists, and a future 5th registration
 *     fails this test (T-03-12).
 *  2. Every write endpoint reachable via `client.post()` across the
 *     trigger + abort write surface matches the `{/build,
 *     /buildWithParameters, /<n>/stop}` allowlist — nothing else (SAFE-02).
 *
 * `JenkinsClient.get()`/`post()` are mocked throughout — this suite never
 * hits a live Jenkins instance or a real network host (matches
 * `bash.test.ts`'s `createMockClient` convention).
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "./jenkins/client.js";
import { TOOL_NAMES } from "./server.js";
import { abortBuild } from "./tools/abort.js";
import { triggerBuild } from "./tools/trigger.js";

/** The one-glance v1 write-boundary allowlist (D-08, SAFE-02). */
const WRITE_ENDPOINT_ALLOWLIST_RE = /(\/build|\/buildWithParameters|\/\d+\/stop)$/;

/**
 * Builds a mocked `JenkinsClient` whose `post()` records every path it is
 * called with (for the write-endpoint-allowlist assertion) and whose
 * `get()` drives `pollQueueItem` deterministically for each queue id used
 * below — no real timers/backoff waiting is required.
 */
function createMockClient(): { client: JenkinsClient; postPaths: string[] } {
  const postPaths: string[] = [];

  const post = vi.fn(async (path: string) => {
    postPaths.push(path);

    if (path.endsWith("/job/no-params-job/build")) {
      return new Response(null, {
        status: 201,
        headers: { Location: "http://jenkins.example/queue/item/101/" },
      });
    }
    if (path.endsWith("/job/with-params-job/buildWithParameters")) {
      return new Response(null, {
        status: 201,
        headers: { Location: "http://jenkins.example/queue/item/102/" },
      });
    }
    if (path.endsWith("/job/queued-job/build")) {
      return new Response(null, {
        status: 201,
        headers: { Location: "http://jenkins.example/queue/item/103/" },
      });
    }
    if (/\/\d+\/stop$/.test(path)) {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  const get = vi.fn(async (path: string) => {
    // Queue item 101/102 resolve to a real build number on the first poll.
    if (path.includes("/queue/item/101/")) {
      return new Response(
        JSON.stringify({
          executable: { number: 201, url: "http://jenkins.example/job/no-params-job/201/" },
        }),
        { status: 200 },
      );
    }
    if (path.includes("/queue/item/102/")) {
      return new Response(
        JSON.stringify({
          executable: { number: 202, url: "http://jenkins.example/job/with-params-job/202/" },
        }),
        { status: 200 },
      );
    }
    // Queue item 103 never resolves and is never cancelled — combined with
    // `timeout: 0` below, this drives the "queued" (unresolved-within-bound)
    // branch after exactly one poll, with no real waiting.
    if (path.includes("/queue/item/103/")) {
      return new Response(JSON.stringify({ blocked: true, why: "In the quiet period" }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  });

  return { client: { get, post } as unknown as JenkinsClient, postPaths };
}

describe("TOOL_NAMES (SAFE-01, criterion 5, D-08)", () => {
  it("equals exactly the four locked v1 tools — no more, no fewer", () => {
    expect(TOOL_NAMES).toHaveLength(4);
    expect([...TOOL_NAMES].sort()).toEqual(
      ["jenkins_abort_build", "jenkins_bash", "jenkins_trigger_build", "jenkins_whoami"].sort(),
    );
  });
});

describe("write-endpoint allowlist (SAFE-02, D-08)", () => {
  it("every client.post path reached by trigger + abort matches {/build, /buildWithParameters, /<n>/stop}", async () => {
    const { client, postPaths } = createMockClient();

    // No-params trigger -> /build, resolves immediately.
    const noParamsResult = await triggerBuild(client, { path: "no-params-job" });
    expect(noParamsResult).toMatchObject({ buildNumber: 201 });

    // With-params trigger -> /buildWithParameters, resolves immediately.
    const withParamsResult = await triggerBuild(client, {
      path: "with-params-job",
      params: { FOO: "bar" },
    });
    expect(withParamsResult).toMatchObject({ buildNumber: 202 });

    // Queued (never resolves within the bound) trigger -> still only /build.
    const queuedResult = await triggerBuild(client, { path: "queued-job", timeout: 0 });
    expect(queuedResult).toMatchObject({ queued: true, queueId: "103" });

    // Abort -> /<n>/stop.
    await abortBuild(client, { path: "abort-job", buildNumber: 55 });

    // Every collected post path across the whole write surface matches the
    // allowlist — nothing else is ever reached (SAFE-02).
    expect(postPaths.length).toBeGreaterThan(0);
    for (const path of postPaths) {
      expect(path).toMatch(WRITE_ENDPOINT_ALLOWLIST_RE);
    }

    // And spot-check the exact three distinct endpoint shapes were reached.
    expect(postPaths).toEqual([
      "/job/no-params-job/build",
      "/job/with-params-job/buildWithParameters",
      "/job/queued-job/build",
      "/job/abort-job/55/stop",
    ]);
  });
});

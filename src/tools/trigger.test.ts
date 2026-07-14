/**
 * Vitest coverage for the jenkins_trigger_build MCP tool adapter (D-01/D-02/
 * D-04/D-04a/D-04b/D-05). `JenkinsClient.get()`/`post()` are mocked
 * throughout — this suite never hits a live Jenkins instance.
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "../jenkins/client.js";
import { extractQueueId, TRIGGER_TOOL_NAME, triggerBuild } from "./trigger.js";

interface QueueFixture {
  body: unknown;
  status?: number;
}

/** Builds a mocked `JenkinsClient` around a single POST response and a sequence of GET (queue-poll) fixtures. */
function createMockClient(options: {
  postStatus?: number;
  postLocation?: string | null;
  queueFixtures?: QueueFixture[];
}): {
  client: JenkinsClient;
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const { postStatus = 201, postLocation = null, queueFixtures = [] } = options;
  let queueCallIndex = 0;

  const post = vi.fn(async () => {
    const headers = new Headers();
    if (postLocation !== null) headers.set("Location", postLocation);
    return new Response(null, { status: postStatus, headers });
  });

  const get = vi.fn(async () => {
    const fixture = queueFixtures[Math.min(queueCallIndex, queueFixtures.length - 1)];
    queueCallIndex += 1;
    return new Response(JSON.stringify(fixture.body), { status: fixture.status ?? 200 });
  });

  return { client: { get, post } as unknown as JenkinsClient, post, get };
}

describe("extractQueueId", () => {
  it("extracts the numeric id from a well-formed Location header", () => {
    expect(extractQueueId("http://jenkins/queue/item/99/")).toBe("99");
    expect(extractQueueId("http://jenkins/queue/item/99")).toBe("99");
  });

  it("throws a JenkinsError when the header is missing or unparsable", () => {
    expect(() => extractQueueId(null)).toThrow(/queue item Location header/i);
    expect(() => extractQueueId("http://jenkins/job/x/1/")).toThrow(/queue item Location header/i);
  });
});

describe("triggerBuild", () => {
  it("POSTs to /build (no buildWithParameters) when no params are given", async () => {
    const { client, post } = createMockClient({
      postLocation: "http://jenkins/queue/item/99/",
      queueFixtures: [{ body: { executable: { number: 42, url: "http://jenkins/job/x/42/" } } }],
    });

    await triggerBuild(client, { path: "app" });

    expect(post).toHaveBeenCalledWith("/job/app/build", undefined);
  });

  it("POSTs to /buildWithParameters with a URLSearchParams body and form-urlencoded header when params are present", async () => {
    const { client, post } = createMockClient({
      postLocation: "http://jenkins/queue/item/99/",
      queueFixtures: [{ body: { executable: { number: 42, url: "http://jenkins/job/x/42/" } } }],
    });

    await triggerBuild(client, { path: "app", params: { branch: "main" } });

    const [calledPath, calledInit] = post.mock.calls[0] as [string, RequestInit];
    expect(calledPath).toBe("/job/app/buildWithParameters");
    expect(calledInit.body).toBeInstanceOf(URLSearchParams);
    expect((calledInit.body as URLSearchParams).get("branch")).toBe("main");
    const headers = new Headers(calledInit.headers);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("builds the REST path via jobPath(parsePathString(path)) for a folder-nested job", async () => {
    const { client, post } = createMockClient({
      postLocation: "http://jenkins/queue/item/99/",
      queueFixtures: [{ body: { executable: { number: 1, url: "http://jenkins/job/x/1/" } } }],
    });

    await triggerBuild(client, { path: "team-a/app" });

    expect(post).toHaveBeenCalledWith("/job/team-a/job/app/build", undefined);
  });

  it("returns {buildNumber, building, url, hint} when the queue item resolves", async () => {
    const { client } = createMockClient({
      postLocation: "http://jenkins/queue/item/99/",
      queueFixtures: [{ body: { executable: { number: 42, url: "http://jenkins/job/x/42/" } } }],
    });

    const result = await triggerBuild(client, { path: "app" });

    expect(result).toMatchObject({
      buildNumber: 42,
      building: true,
      url: "http://jenkins/job/x/42/",
    });
    expect((result as { hint: string }).hint).toMatch(/jenkins_bash/);
    expect(result).not.toHaveProperty("queueId");
  });

  it("returns {queued:true, queueId, why, hint} with NO buildNumber field when the bounded wait elapses", async () => {
    const { client } = createMockClient({
      postLocation: "http://jenkins/queue/item/99/",
      queueFixtures: [{ body: { blocked: true, why: "waiting for executor" } }],
    });

    const result = await triggerBuild(client, { path: "app", timeout: 0 });

    expect(result).toMatchObject({ queued: true, queueId: "99", why: "waiting for executor" });
    expect((result as { hint: string }).hint).toMatch(/jenkins_bash/);
    expect(result).not.toHaveProperty("buildNumber");
  });

  it("throws normalizeError(res, ...) when the trigger POST returns a non-ok status", async () => {
    const { client } = createMockClient({ postStatus: 500 });

    await expect(triggerBuild(client, { path: "app" })).rejects.toMatchObject({
      name: "JenkinsError",
      operation: TRIGGER_TOOL_NAME,
    });
  });

  it("throws a JenkinsError (never fabricates a build number) when the Location header is missing", async () => {
    const { client } = createMockClient({ postLocation: null });

    await expect(triggerBuild(client, { path: "app" })).rejects.toMatchObject({
      name: "JenkinsError",
    });
  });
});

/**
 * Vitest coverage for the jenkins_abort_build MCP tool adapter (CTRL-04,
 * D-06, SAFE-02). `JenkinsClient.post()` is mocked throughout - this suite
 * never hits a live Jenkins instance.
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "../jenkins/client.js";
import { ABORT_TOOL_NAME, abortBuild } from "./abort.js";

/** Builds a mocked `JenkinsClient` whose `post()` always returns `status`. */
function createMockClient(status: number): {
  client: JenkinsClient;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async () => new Response(null, { status }));
  const get = vi.fn(async () => new Response(null, { status: 200 }));
  return { client: { get, post } as unknown as JenkinsClient, post };
}

describe("abortBuild", () => {
  it("POSTs exactly once to /job/<path>/<buildNumber>/stop for a folder-nested job", async () => {
    const { client, post } = createMockClient(200);

    await abortBuild(client, { path: "team-a/app", buildNumber: 42 });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/job/team-a/job/app/42/stop");
  });

  it("resolves without throwing on a 200 (or any 2xx) response", async () => {
    const { client } = createMockClient(200);

    await expect(abortBuild(client, { path: "app", buildNumber: 1 })).resolves.toBeUndefined();
  });

  it("resolves without throwing on a 302 response (Jenkins /stop redirect on success, Assumption A1)", async () => {
    const { client } = createMockClient(302);

    await expect(abortBuild(client, { path: "app", buildNumber: 1 })).resolves.toBeUndefined();
  });

  it("throws normalizeError(res, jenkins_abort_build) on a 403 response", async () => {
    const { client } = createMockClient(403);

    await expect(abortBuild(client, { path: "app", buildNumber: 1 })).rejects.toMatchObject({
      name: "JenkinsError",
      operation: ABORT_TOOL_NAME,
    });
  });

  it("throws normalizeError(res, jenkins_abort_build) on a 404 (or any other non-ok, non-302) response", async () => {
    const { client } = createMockClient(404);

    await expect(abortBuild(client, { path: "app", buildNumber: 1 })).rejects.toMatchObject({
      name: "JenkinsError",
      operation: ABORT_TOOL_NAME,
    });
  });

  it("never reaches an endpoint other than /stop across all invocations (SAFE-02)", async () => {
    const { client, post } = createMockClient(200);

    await abortBuild(client, { path: "team-a/app", buildNumber: 42 });
    await abortBuild(client, { path: "job1", buildNumber: 7 });

    for (const call of post.mock.calls) {
      const calledPath = call[0] as string;
      expect(calledPath).toMatch(/\/\d+\/stop$/);
      expect(calledPath).not.toMatch(/\/(term|kill)$/);
    }
    expect(post).toHaveBeenCalledTimes(2);
  });
});

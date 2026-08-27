/**
 * Shared Jenkins response fixtures.
 *
 * The `_class` strings here are the real ones a live Jenkins returns, carried
 * over from the deleted VFS suite. That matters more than it looks: every
 * classification helper in this package branches on substrings of `_class`, so
 * a fixture with an invented class value would pass tests that a real instance
 * would fail.
 *
 * These live in one module (rather than being re-declared per test file)
 * because Jenkins payloads are large and duplicating them is how a field drops
 * out of one copy and the drift goes unnoticed.
 */

import { vi } from "vitest";
import type { JenkinsClient } from "../client.js";
import type { ApiJobsResponse } from "../types.js";

export const FOLDER_CLASS = "com.cloudbees.hudson.plugins.folder.Folder";
export const FREESTYLE_CLASS = "hudson.model.FreeStyleProject";
export const MULTIBRANCH_CLASS =
  "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject";
export const WORKFLOW_CLASS = "org.jenkinsci.plugins.workflow.job.WorkflowJob";

/**
 * A folder containing a freestyle job, and a multibranch job containing one
 * branch whose name contains a `%2F`-encoded slash plus a PR child.
 */
export const NESTED_INDEX: ApiJobsResponse = {
  jobs: [
    {
      name: "team-a",
      fullName: "team-a",
      _class: FOLDER_CLASS,
      jobs: [
        {
          name: "freestyle-job",
          fullName: "team-a/freestyle-job",
          _class: FREESTYLE_CLASS,
          color: "blue",
          scm: { userRemoteConfigs: [{ url: "ssh://git@bitbucket.example.com/team/svc.git" }] },
        },
      ],
    },
    {
      name: "my-multibranch",
      fullName: "my-multibranch",
      _class: MULTIBRANCH_CLASS,
      jobs: [
        {
          name: "feature%2Ffoo",
          fullName: "my-multibranch/feature%2Ffoo",
          _class: WORKFLOW_CLASS,
          color: "red",
        },
        {
          name: "PR-42",
          fullName: "my-multibranch/PR-42",
          _class: WORKFLOW_CLASS,
          color: "blue_anime",
        },
      ],
    },
  ],
};

/** A GET fixture: matched by substring against the requested path. */
export interface GetFixture {
  match: string;
  body?: unknown;
  text?: string;
  status?: number;
}

/**
 * Builds a fake `JenkinsClient` that dispatches GETs by path substring.
 *
 * Operation tests fake the CLIENT, never global fetch: the client's own
 * contract (auth, crumb, retry, timeout) is tested once in client.test.ts, and
 * faking fetch in every operation test would couple all of them to it.
 */
export function createMockClient(fixtures: GetFixture[]): {
  client: JenkinsClient;
  get: ReturnType<typeof makeGet>;
  post: ReturnType<typeof makePost>;
} {
  const get = makeGet(fixtures);
  const post = makePost();
  return {
    client: { get, post, baseUrl: "https://jenkins.example.com" } as unknown as JenkinsClient,
    get,
    post,
  };
}

function makeGet(fixtures: GetFixture[]) {
  return vi.fn(async (path: string) => {
    const fixture = fixtures.find((candidate) => path.includes(candidate.match));
    if (fixture === undefined) return new Response("not found", { status: 404 });
    const body = fixture.text ?? JSON.stringify(fixture.body ?? {});
    return new Response(body, { status: fixture.status ?? 200 });
  });
}

function makePost() {
  return vi.fn(async () => new Response("{}", { status: 200 }));
}

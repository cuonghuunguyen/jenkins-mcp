/**
 * Structural safety-boundary tests (SAFE-01/SAFE-02, D-08).
 *
 * These are the durable, assertion-backed guards that:
 *
 *  1. The registered tool-name set is exactly the locked list - no
 *     create/update/delete tool exists, and adding a tool without updating
 *     this test fails it.
 *  1a. Under JENKINS_MCP_READONLY the two write tools are not registered AT
 *     ALL (SAFE-03) - the read-only list must contain no tool that can POST,
 *     because a tool an agent can see but not use is worse than no tool.
 *  2. Every endpoint reachable via `client.post()` across the whole write
 *     surface matches the `{/build, /buildWithParameters, /<n>/stop}`
 *     allowlist - nothing else.
 *  3. The read-only tools reach zero `client.post()` endpoints - asserted
 *     BEHAVIOURALLY, by invoking every registered read-only handler against a
 *     client whose `post` fails the test if it is called. The old version of
 *     this assertion compared the read-only tool list against a hardcoded
 *     two-name array, which is a tautology given the list assertion above it:
 *     it never exercised a handler, never observed a request, and did not
 *     notice that `jenkins_whoami` POSTed to `/me/api/json` in read-only mode.
 *
 * `JenkinsClient` is faked throughout: this suite never touches a network.
 */

import {
  abortBuild,
  diagnoseBuild,
  findJobs,
  JenkinsCache,
  type JenkinsClient,
  triggerBuild,
  validateConfig,
  whoami,
} from "@cuonghuunguyen/jenkins-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { toolNames } from "../server.js";
import { registerBuildTools } from "../tools/build.js";
import { registerControlTools } from "../tools/control.js";
import { registerJobTools } from "../tools/job.js";
import { registerLogTools } from "../tools/log.js";
import { registerMiscTools } from "../tools/misc.js";
import { registerReadTools } from "../tools/read.js";

/** The only two tools that may ever issue a POST (SAFE-02/SAFE-03). */
const WRITE_TOOLS = ["jenkins_trigger_build", "jenkins_abort_build"];

/** The one-glance write-boundary allowlist (D-08, SAFE-02). */
const WRITE_ENDPOINT_ALLOWLIST_RE =
  /(\/build|\/buildWithParameters|\/(?:\d+|last[A-Za-z]*Build)\/stop)$/;

function createMockClient(): { client: JenkinsClient; postPaths: string[] } {
  const postPaths: string[] = [];

  const post = vi.fn(async (path: string) => {
    postPaths.push(path);
    if (path.endsWith("/stop")) return new Response(null, { status: 200 });
    return new Response(null, {
      status: 201,
      headers: { Location: "http://jenkins.example/queue/item/101/" },
    });
  });

  const get = vi.fn(async (path: string) => {
    if (path.includes("tree=property")) {
      // Only `with-params-job` declares a parameter, so the params-carrying
      // trigger below validates and the others post to plain /build.
      const declared = path.includes("with-params-job")
        ? [{ parameterDefinitions: [{ name: "BRANCH", defaultParameterValue: { value: "main" } }] }]
        : [];
      return new Response(JSON.stringify({ property: declared }), { status: 200 });
    }
    if (path.includes("/queue/item/")) {
      return new Response(
        JSON.stringify({ executable: { number: 7, url: "http://jenkins.example/7/" } }),
        { status: 200 },
      );
    }
    if (path.includes("/api/json?tree=jobs[")) {
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }
    // A finished, successful build - diagnose stops early without a wfapi call.
    return new Response(JSON.stringify({ result: "SUCCESS", building: false }), { status: 200 });
  });

  return {
    client: { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient,
    postPaths,
  };
}

describe("tool surface (SAFE-01)", () => {
  it("registers exactly the locked tool list, with no create/update/delete capability", () => {
    expect([...toolNames()].sort()).toEqual([
      "jenkins_abort_build",
      "jenkins_api_get",
      "jenkins_build",
      "jenkins_diagnose_build",
      "jenkins_find_jobs",
      "jenkins_job",
      "jenkins_log",
      "jenkins_queue",
      "jenkins_trigger_build",
      "jenkins_wait_build",
      "jenkins_whoami",
    ]);
  });

  it("exposes no tool whose name implies creating, updating or deleting Jenkins state", () => {
    for (const name of toolNames()) {
      expect(name).not.toMatch(/create|update|delete|remove|set_|configure|install/i);
    }
  });

  it("no longer exposes the removed VFS shell tool", () => {
    expect(toolNames()).not.toContain("jenkins_bash");
  });
});

describe("write-endpoint allowlist (SAFE-02)", () => {
  it("reaches only /build, /buildWithParameters and /<n>/stop across the whole write surface", async () => {
    const { client, postPaths } = createMockClient();
    const cache = new JenkinsCache();

    await triggerBuild(client, cache, { job: "no-params-job" });
    await triggerBuild(client, cache, { job: "with-params-job", params: { BRANCH: "main" } });
    await triggerBuild(client, cache, { job: "team-a/svc", ref: "PR-42" });
    await abortBuild(client, cache, { job: "team-a/svc", ref: "PR-42", build: 7 });

    expect(postPaths.length).toBe(4);
    for (const path of postPaths) {
      expect(path).toMatch(WRITE_ENDPOINT_ALLOWLIST_RE);
    }
    // Never the forceful escalation endpoints.
    for (const path of postPaths) {
      expect(path).not.toMatch(/\/(term|kill)$/);
    }
  });

  it("routes a ref-addressed abort at the branch job, not the multibranch parent", async () => {
    const { client, postPaths } = createMockClient();

    await abortBuild(client, new JenkinsCache(), {
      job: "team-a/svc",
      ref: "feature/foo",
      build: 12,
    });

    expect(postPaths).toEqual(["/job/team-a/job/svc/job/feature%2Ffoo/12/stop"]);
  });
});

describe("abort addressing and cache invalidation (CTRL-08)", () => {
  it("aborts the running build when addressed by the lastBuild alias", async () => {
    const { client, postPaths } = createMockClient();

    await abortBuild(client, new JenkinsCache(), { job: "team-a/svc", build: "lastBuild" });

    expect(postPaths).toEqual(["/job/team-a/job/svc/lastBuild/stop"]);
  });

  it("drops the job's cached entries, so the next read is not the pre-abort state", async () => {
    const { client } = createMockClient();
    const cache = new JenkinsCache();
    await cache.fetch("job:team-a/svc ref: build:7 summary", async () => ({}), "permanent");

    await abortBuild(client, cache, { job: "team-a/svc", build: 7 });

    expect(cache.size()).toBe(0);
  });
});

describe("JENKINS_MCP_READONLY parsing (SAFE-03)", () => {
  const base = {
    JENKINS_URL: "http://jenkins.example",
    JENKINS_USER: "alice",
    JENKINS_API_TOKEN: "token",
  };

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["yes", false],
    ["", false],
    [undefined, false],
  ])("reads %s as %s, and never throws on junk", (raw, expected) => {
    const result = validateConfig({ ...base, JENKINS_MCP_READONLY: raw });

    expect(result.success && result.data.readonly).toBe(expected);
  });

  it.each(["yes", "on", "y", "enabled", "ture"])(
    "warns on stderr for the unrecognised value %s instead of failing open silently",
    (raw) => {
      // A plausible operator typo yielded a full WRITE server with a normal
      // startup and no warning; the first sign of trouble was an agent
      // triggering a build on an instance meant to be read-only.
      const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const result = validateConfig({ ...base, JENKINS_MCP_READONLY: raw });

        expect(result.success && result.data.readonly).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognised value"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("write tools ARE registered"));
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each(["1", "true", "0", "false", "no", "off", ""])(
    "stays silent for the recognised value %s",
    (raw) => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        validateConfig({ ...base, JENKINS_MCP_READONLY: raw });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe("read-only mode (SAFE-03)", () => {
  it("registers the read tools but not the two write tools", () => {
    expect([...toolNames(true)].sort()).toEqual([
      "jenkins_api_get",
      "jenkins_build",
      "jenkins_diagnose_build",
      "jenkins_find_jobs",
      "jenkins_job",
      "jenkins_log",
      "jenkins_queue",
      "jenkins_wait_build",
      "jenkins_whoami",
    ]);
  });

  it("exposes no tool that can issue a POST", () => {
    for (const name of toolNames(true)) {
      expect(WRITE_TOOLS).not.toContain(name);
    }
  });

  it("INVOKES every read-only tool and observes zero POSTs", async () => {
    // The behavioural half of SAFE-03. `jenkins_whoami` used to POST to
    // `/me/api/json` - deliberately, to exercise the crumb path - and it is
    // registered in read-only mode, so the project's central safety claim was
    // false on the very first identity check an agent makes. A name-comparison
    // test could not see that; this one drives the real handlers.
    const posted: string[] = [];
    const post = vi.fn(async (path: string) => {
      posted.push(path);
      return new Response(null, { status: 200 });
    });
    const client = { ...readonlyProbeClient(), post } as unknown as JenkinsClient;

    const { handlers, names } = registerReadonlySurface(client);
    expect(names.sort()).toEqual([...toolNames(true)].sort());

    for (const name of names) {
      const handler = handlers.get(name);
      expect(handler, `${name} has no handler`).toBeDefined();
      // Every read-only tool answers with job/build/path defaults the probe
      // client serves; a throw is fine, a POST is not.
      await handler?.(READONLY_PROBE_ARGS).catch(() => undefined);
    }

    expect(posted).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    // Proof the handlers really RAN: a test that silently invoked nothing
    // would also observe zero POSTs, which is the tautology this replaced.
    expect(client.get).toHaveBeenCalled();
    expect(
      (client.get as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBeGreaterThan(names.length - 2);
  });

  it("keeps jenkins_whoami on GET, since it is registered in read-only mode", async () => {
    const get = vi.fn(async () => new Response(JSON.stringify({ id: "alice" }), { status: 200 }));
    const post = vi.fn(async () => new Response(null, { status: 200 }));

    const identity = await whoami({ get, post, baseUrl: "http://x" } as unknown as JenkinsClient);

    expect(identity.id).toBe("alice");
    expect(get).toHaveBeenCalledWith("/me/api/json");
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps watching available - a read-only agent can still follow a build", () => {
    expect(toolNames(true)).toContain("jenkins_wait_build");
  });

  it("differs from the read-write list by exactly the two write tools", () => {
    const removed = toolNames(false).filter((name) => !toolNames(true).includes(name));
    expect([...removed].sort()).toEqual([...WRITE_TOOLS].sort());
  });
});

describe("read-only tools issue no writes (Phase 4 D-02)", () => {
  it("leaves the POST surface untouched", async () => {
    const { client, postPaths } = createMockClient();
    const cache = new JenkinsCache();

    await diagnoseBuild(client, cache, { job: "team-a/svc", build: 3 });
    await findJobs(client, cache, { depth: 6 });

    expect(postPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behavioural read-only harness
// ---------------------------------------------------------------------------

/** Arguments broad enough for every read-only tool's schema at once. */
const READONLY_PROBE_ARGS = {
  job: "team-a/svc",
  build: 3,
  query: "svc",
  path: "/api/json",
  tree: "jobs[name]",
  timeout_s: 0,
};

/** A `get` that answers every read-only tool with a benign, finished fixture. */
function readonlyProbeClient() {
  const get = vi.fn(async (path: string) => {
    if (path.includes("tree=jobs["))
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    if (path.includes("/wfapi/describe")) return new Response(null, { status: 404 });
    if (path.includes("/testReport/")) return new Response(null, { status: 404 });
    if (path.includes("consoleText") || path.includes("logText")) {
      return new Response("done\n", { status: 200 });
    }
    if (path === "/me/api/json") {
      return new Response(JSON.stringify({ id: "alice" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ number: 3, result: "SUCCESS", building: false, jobs: [] }),
      { status: 200 },
    );
  });
  return { get, baseUrl: "http://jenkins.example" };
}

/**
 * Registers the read-only surface against a capturing fake `McpServer` and
 * returns the real handlers, so they can be INVOKED rather than merely named.
 */
function registerReadonlySurface(client: JenkinsClient): {
  handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
  names: string[];
} {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const cache = new JenkinsCache();
  const names = [
    ...registerReadTools(server, client, cache, 4),
    ...registerJobTools(server, client, cache, 4),
    ...registerBuildTools(server, client, cache, 4),
    ...registerLogTools(server, client, cache, 4),
    ...registerMiscTools(server, client, cache),
    ...registerControlTools(server, client, cache, 4, true),
  ];
  return { handlers, names };
}

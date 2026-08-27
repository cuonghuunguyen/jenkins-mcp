/**
 * Adapter-level tests: the tool registrations and the `runTool` contract.
 *
 * These assert the ADAPTER's job only - result shape, schema presence, error
 * rendering, placeholder resolution. What the operations compute is tested in
 * core; duplicating it here would just double the maintenance.
 */

import { JenkinsCache, type JenkinsClient, JenkinsError } from "@jenkins-mcp/core";
import { describe, expect, it, vi } from "vitest";
import { registerControlTools } from "../tools/control.js";
import { registerReadTools } from "../tools/read.js";
import { MCP_VOCABULARY, runTool } from "../tools/result.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Captures registrations off a fake `McpServer`. */
function createMockServer() {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  return {
    server,
    config: (name: string) => configs.get(name),
    handler: (name: string) => {
      const found = handlers.get(name);
      if (found === undefined) throw new Error(`tool not registered: ${name}`);
      return found;
    },
  };
}

function register() {
  const mock = createMockServer();
  const get = vi.fn(async (path: string) => {
    if (path.includes("/api/json?tree=jobs[")) {
      return new Response(
        JSON.stringify({
          jobs: [
            {
              fullName: "team-a/svc",
              name: "svc",
              _class: "hudson.model.FreeStyleProject",
              color: "blue",
            },
          ],
        }),
        { status: 200 },
      );
    }
    // `/me/api/json` is a READ and is now issued with GET, so the read-only
    // tool surface genuinely reaches zero POST endpoints (SAFE-03).
    if (path === "/me/api/json") {
      return new Response(JSON.stringify({ id: "alice" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  const post = vi.fn(async () => new Response("{}", { status: 200 }));
  const client = { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient;
  const cache = new JenkinsCache();

  const names = [
    ...registerReadTools(mock.server as never, client, cache, 6),
    ...registerControlTools(mock.server as never, client, cache),
  ];
  return { ...mock, names, get, post };
}

describe("tool registration (MCP-02)", () => {
  it("gives every tool a human-readable description and an input schema", () => {
    const { names, config } = register();

    for (const name of names) {
      const registered = config(name);
      expect(registered?.description.length ?? 0).toBeGreaterThan(40);
      expect(registered?.inputSchema).toBeDefined();
    }
  });

  it("declares job, ref and build on the tools that address a build", () => {
    const { config } = register();

    for (const name of ["jenkins_abort_build", "jenkins_diagnose_build"]) {
      expect(Object.keys(config(name)?.inputSchema ?? {})).toEqual(["job", "ref", "build"]);
    }
  });

  it("takes no input at all for jenkins_whoami", () => {
    const { config } = register();
    expect(Object.keys(config("jenkins_whoami")?.inputSchema ?? {})).toEqual([]);
  });
});

describe("handler results", () => {
  it("returns the core formatter's text as an MCP text block", async () => {
    const { handler } = register();

    const result = await handler("jenkins_whoami")({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("authenticated: alice");
  });

  it("resolves core's {ref} placeholders to real tool names before they reach the client", async () => {
    const { handler } = register();

    const text = (await handler("jenkins_whoami")({})).content[0]?.text ?? "";

    expect(text).toContain("next: jenkins_find_jobs");
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("renders a job search through the compact table formatter", async () => {
    const { handler } = register();

    const text = (await handler("jenkins_find_jobs")({ query: "svc" })).content[0]?.text ?? "";

    expect(text).toContain("jobs (1)");
    expect(text).toContain("team-a/svc");
  });
});

describe("runTool error contract (AGNT-05)", () => {
  it("turns a thrown JenkinsError into one structured error line, flagged isError", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runTool("jenkins_job", async () => {
      throw new JenkinsError("Job not found.", "jenkins_job", 404, "not_found", "{findJobs}");
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "error: not_found — Job not found. — try: jenkins_find_jobs",
    );
    consoleError.mockRestore();
  });

  it("logs the failure to stderr, never stdout, so the JSON-RPC channel stays clean", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runTool("jenkins_job", async () => {
      throw new Error("boom");
    });

    expect(consoleError).toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    consoleError.mockRestore();
    stdoutWrite.mockRestore();
  });

  it("withholds an unexpected error's own message, which may echo request details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runTool("jenkins_job", async () => {
      throw new Error("Authorization: Basic c3VwZXItc2VjcmV0");
    });

    expect(result.content[0]?.text).toBe("error: internal — An unexpected error occurred");
    expect(result.content[0]?.text).not.toContain("c3VwZXItc2VjcmV0");
    consoleError.mockRestore();
  });
});

describe("MCP vocabulary", () => {
  it("covers every command ref core can emit, so no literal {ref} can leak", () => {
    for (const [ref, name] of Object.entries(MCP_VOCABULARY)) {
      expect(name, `vocabulary entry for {${ref}}`).toMatch(/^jenkins_/);
    }
  });
});

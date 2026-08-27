/**
 * `jenkins_build` adapter contract only: the declared input schema and the
 * error rendering. What the operation computes is tested in core.
 */

import { JenkinsCache, type JenkinsClient, JenkinsError } from "@jenkins-mcp/core";
import { describe, expect, it, vi } from "vitest";
import { registerBuildTools } from "../tools/build.js";
import { runTool } from "../tools/result.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

function register() {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };

  const get = vi.fn(async (path: string) => {
    if (path.includes("/api/json?tree=jobs[")) {
      return new Response(
        JSON.stringify({
          jobs: [
            {
              fullName: "team-a/svc",
              name: "svc",
              _class: "hudson.model.FreeStyleProject",
              color: "red",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (path.includes("/api/json?tree=number")) {
      return new Response(
        JSON.stringify({
          number: 42,
          result: "FAILURE",
          building: false,
          duration: 200_000,
          timestamp: Date.now() - 240_000,
          _class: "hudson.model.FreeStyleBuild",
          actions: [{}, { causes: [{ shortDescription: "Started by user alice" }] }],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const client = {
    get,
    post: vi.fn(),
    baseUrl: "http://jenkins.example",
  } as unknown as JenkinsClient;
  const names = registerBuildTools(server as never, client, new JenkinsCache(), 4);

  return {
    names,
    config: (name: string) => configs.get(name),
    handler: (name: string) => {
      const found = handlers.get(name);
      if (found === undefined) throw new Error(`tool not registered: ${name}`);
      return found;
    },
  };
}

describe("registerBuildTools (READ-09)", () => {
  it("registers jenkins_build with a description and job/ref/build inputs", () => {
    const { names, config } = register();

    expect(names).toEqual(["jenkins_build"]);
    const registered = config("jenkins_build");
    expect(registered?.description.length ?? 0).toBeGreaterThan(40);
    expect(Object.keys(registered?.inputSchema ?? {})).toEqual(["job", "ref", "build"]);
  });

  it("says in the description that one call covers everything, and that build defaults", () => {
    const description = register().config("jenkins_build")?.description ?? "";

    for (const promised of [
      "status",
      "cause",
      "parameters",
      "commits",
      "stages",
      "failed steps",
      "failed tests",
      "defaults to the last build",
    ]) {
      expect(description, `description mentions ${promised}`).toContain(promised);
    }
  });

  it("renders the core formatter's text with {ref} placeholders resolved", async () => {
    const text =
      (await register().handler("jenkins_build")({ job: "team-a/svc", build: 42 })).content[0]
        ?.text ?? "";

    expect(text).toContain("team-a/svc #42  FAILURE");
    expect(text).toContain("cause: Started by user alice");
    expect(text).toContain("next: jenkins_diagnose_build");
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("turns a thrown JenkinsError into one error line flagged isError (AGNT-05)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runTool("jenkins_build", async () => {
      throw new JenkinsError("Build not found.", "jenkins_build", 404, "not_found", "{findJobs}");
    });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe(
      "error: not_found — Build not found. — try: jenkins_find_jobs",
    );
    consoleError.mockRestore();
  });

  it("reports an invalid build selector through the same one-line error contract", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await register().handler("jenkins_build")({ job: "team-a/svc", build: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^error: invalid_input — /);
    consoleError.mockRestore();
  });
});

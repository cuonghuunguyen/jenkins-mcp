/**
 * `jenkins_job` adapter tests.
 *
 * Adapter concerns only - registration, schema presence, result shape,
 * placeholder resolution. What the operation computes is tested in core.
 */

import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { describe, expect, it, vi } from "vitest";
import { registerJobTools } from "../tools/job.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

const INDEX = {
  jobs: [
    {
      fullName: "team-a/svc",
      name: "svc",
      _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
      jobs: [
        {
          fullName: "team-a/svc/main",
          name: "main",
          _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
          color: "blue",
        },
      ],
    },
  ],
};

const JOB = {
  name: "main",
  fullName: "team-a/svc/main",
  buildable: true,
  _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
  property: [{}],
  builds: [{ number: 7, result: "SUCCESS", building: false, timestamp: 1, duration: 1000 }],
};

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
    const body = path.includes("tree=jobs[") ? INDEX : JOB;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const client = {
    get,
    post: vi.fn(),
    baseUrl: "http://jenkins.example",
  } as unknown as JenkinsClient;

  const names = registerJobTools(server as never, client, new JenkinsCache(), 6);
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

describe("jenkins_job registration (MCP-02)", () => {
  it("registers exactly jenkins_job", () => {
    expect(register().names).toEqual(["jenkins_job"]);
  });

  it("declares job and ref as its inputs", () => {
    expect(Object.keys(register().config("jenkins_job")?.inputSchema ?? {})).toEqual([
      "job",
      "ref",
    ]);
  });

  it("tells the caller about the multibranch listing and the 10-build window", () => {
    const description = register().config("jenkins_job")?.description ?? "";

    expect(description).toMatch(/multibranch/);
    expect(description).toMatch(/branches/);
    expect(description).toMatch(/last 10 builds/);
  });
});

describe("jenkins_job handler", () => {
  it("returns the core formatter's text as a text block", async () => {
    const result = await register().handler("jenkins_job")({ job: "team-a/svc", ref: "main" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("team-a/svc/main");
  });

  it("lists a multibranch parent's children when called without a ref (REF-02)", async () => {
    const text =
      (await register().handler("jenkins_job")({ job: "team-a/svc" })).content[0]?.text ?? "";

    expect(text).toContain("multibranch (1)");
    expect(text).toContain("main");
  });

  it("resolves every {ref} placeholder to a real tool name", async () => {
    const text =
      (await register().handler("jenkins_job")({ job: "team-a/svc", ref: "main" })).content[0]
        ?.text ?? "";

    expect(text).toContain("next: jenkins_build");
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

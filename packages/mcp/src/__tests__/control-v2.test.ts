/**
 * Control-surface adapter contract (CTRL-06/CTRL-07/CTRL-08, SAFE-03).
 *
 * What the operations compute is tested in core; this asserts the adapter's
 * own job: which tools exist in each mode, that the snake_case tool inputs
 * reach the right core arguments, that `timeout` is exposed in SECONDS, and
 * that a rejection comes back as one placeholder-free error line.
 */

import { DEFAULT_WAIT_TIMEOUT_MS, JenkinsCache, type JenkinsClient } from "@jenkins-mcp/core";
import { describe, expect, it, vi } from "vitest";
import { registerControlTools } from "../tools/control.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

const DECLARED = [
  {
    parameterDefinitions: [
      { name: "BRANCH", defaultParameterValue: { value: "main" } },
      { name: "ENV", choices: ["dev", "prod"] },
    ],
  },
];

function register(options: { readonly?: boolean; building?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };

  const get = vi.fn(async (path: string) => {
    if (path.includes("tree=property")) {
      return new Response(JSON.stringify({ property: DECLARED }), { status: 200 });
    }
    if (path.includes("tree=actions[parameters")) {
      return new Response(
        JSON.stringify({ actions: [{ parameters: [{ name: "BRANCH", value: "release" }] }] }),
        { status: 200 },
      );
    }
    if (path.includes("/queue/item/")) {
      return new Response(
        JSON.stringify({ executable: { number: 7, url: "http://jenkins.example/7/" } }),
        { status: 200 },
      );
    }
    if (path.includes("tree=number,result,building")) {
      return new Response(
        JSON.stringify({
          number: 7,
          result: options.building === true ? null : "SUCCESS",
          building: options.building === true,
          duration: 1000,
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const post = vi.fn(
    async () =>
      new Response(null, {
        status: 201,
        headers: { Location: "http://jenkins.example/queue/item/101/" },
      }),
  );

  const client = { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient;
  const names = registerControlTools(
    server as never,
    client,
    new JenkinsCache(),
    4,
    options.readonly,
  );

  return {
    names,
    post,
    get,
    config: (name: string) => configs.get(name),
    handler: (name: string) => {
      const found = handlers.get(name);
      if (found === undefined) throw new Error(`tool not registered: ${name}`);
      return found;
    },
  };
}

describe("registration (SAFE-03)", () => {
  it("registers watch, diagnose, trigger and abort in read-write mode", () => {
    expect(register().names).toEqual([
      "jenkins_wait_build",
      "jenkins_diagnose_build",
      "jenkins_trigger_build",
      "jenkins_abort_build",
    ]);
  });

  it("registers only the read-only half under readonly, and never builds a write handler", () => {
    const registered = register({ readonly: true });

    expect(registered.names).toEqual(["jenkins_wait_build", "jenkins_diagnose_build"]);
    expect(() => registered.handler("jenkins_trigger_build")).toThrowError(/not registered/);
    expect(() => registered.handler("jenkins_abort_build")).toThrowError(/not registered/);
  });
});

describe("jenkins_wait_build (CTRL-06)", () => {
  it("declares job, ref, build, the seconds-valued timeout and both cursors", () => {
    expect(Object.keys(register().config("jenkins_wait_build")?.inputSchema ?? {})).toEqual([
      "job",
      "ref",
      "build",
      "timeout_s",
      "since_cursor",
      "log_cursor",
    ]);
  });

  it("renders the finished build with placeholders resolved to tool names", async () => {
    const result = await register().handler("jenkins_wait_build")({ job: "svc", build: 7 });

    expect(result.content[0]?.text).toContain("status: SUCCESS");
    expect(result.content[0]?.text).toContain("jenkins_log");
    expect(result.content[0]?.text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("converts the timeout from seconds, so 0 gives up immediately instead of waiting 120s", async () => {
    const result = await register({ building: true }).handler("jenkins_wait_build")({
      job: "svc",
      build: 7,
      timeout_s: 0,
    });

    expect(result.content[0]?.text).toContain("still BUILDING");
    expect(result.isError).toBeUndefined();
  });
});

describe("jenkins_trigger_build (CTRL-07)", () => {
  it("declares the snake_case control inputs", () => {
    expect(Object.keys(register().config("jenkins_trigger_build")?.inputSchema ?? {})).toEqual([
      "job",
      "ref",
      "params",
      "timeout",
      "rebuild_from",
      "wait",
      "wait_timeout_s",
    ]);
  });

  it("maps rebuild_from and wait onto the core arguments", async () => {
    const result = await register().handler("jenkins_trigger_build")({
      job: "svc",
      rebuild_from: 5,
      wait: true,
    });

    expect(result.content[0]?.text).toContain("inherited: BRANCH");
    expect(result.content[0]?.text).toContain("status: SUCCESS");
  });

  it("returns a rejected parameter as one structured error line, with nothing posted", async () => {
    const registered = register();

    const result = await registered.handler("jenkins_trigger_build")({
      job: "svc",
      params: { ENV: "staging" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text.trimEnd().split("\n")).toHaveLength(1);
    expect(result.content[0]?.text).toMatch(/^error: invalid_input — /);
    expect(registered.post).not.toHaveBeenCalled();
  });
});

describe("jenkins_abort_build (CTRL-08)", () => {
  it("defaults an omitted build to the most recent one", async () => {
    const registered = register();

    const result = await registered.handler("jenkins_abort_build")({ job: "svc" });

    // `redirect: "manual"` is what makes abort.ts's `302 is also success`
    // branch reachable: under fetch's default `follow`, the status the caller
    // sees is the REDIRECT TARGET's.
    expect(registered.post).toHaveBeenCalledWith("/job/svc/lastBuild/stop", {
      redirect: "manual",
    });
    expect(result.content[0]?.text).toContain("aborted: svc #lastBuild");
  });
});

// ---------------------------------------------------------------------------
// Surface-specific timeout defaults (Phase 7 criterion 0/1/2)
// ---------------------------------------------------------------------------

describe("wait timeout defaults reaching the operation", () => {
  it("MCP jenkins_wait_build leaves the bound to core's 120s default", async () => {
    // The criterion is MCP = 120s, CLI = unbounded. The adapter's job is to
    // pass `undefined` (so core's default applies) rather than a number of its
    // own, and core's default is the 120s the tool description advertises.
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(120_000);

    const { config } = register();
    expect(config("jenkins_wait_build")?.description).toContain("wfapi/describe");
    const timeoutField = config("jenkins_wait_build")?.inputSchema.timeout_s as {
      description?: () => string;
    } & { _def?: unknown };
    // zod exposes the describe() text differently across versions; both the
    // schema's own description and the tool description must say 120.
    const described = (timeoutField as unknown as { description?: string }).description;
    expect(described ?? "").toContain("default 120");
  });

  it("converts timeout_s to milliseconds on the way into core", async () => {
    // A 0.05s bound gives exactly one poll and a timeout RESULT, which is only
    // reachable if the seconds -> ms conversion happened.
    const result = await register({ building: true }).handler("jenkins_wait_build")({
      job: "svc",
      build: 7,
      timeout_s: 0.05,
    });

    expect(result.content[0]?.text).toContain("still BUILDING");
    expect(result.isError).toBeUndefined();
  });

  it("passes since_cursor and log_cursor through to core", async () => {
    const registered = register({ building: true });

    await registered.handler("jenkins_wait_build")({
      job: "svc",
      build: 7,
      timeout_s: 0.01,
      log_cursor: 512,
    });

    expect(registered.get.mock.calls.some(([p]) => String(p).includes("start=512"))).toBe(true);
  });
});

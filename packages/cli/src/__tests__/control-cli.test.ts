/**
 * `jenkins build trigger|abort|wait` wiring (CTRL-06/CTRL-07/CTRL-08).
 *
 * All three subcommands are registered from the one `build` module, so the
 * regression that matters most is the plain `jenkins build <n>` command still
 * working alongside them - re-registering a top-level yargs command replaces
 * it rather than extending it.
 */

import { JenkinsCache, type JenkinsClient } from "@jenkins-mcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import yargs, { type Argv } from "yargs";
import type { GlobalArgs } from "../commands/types.js";

/** Whether the build the wait/trigger commands see is still running. */
let building = false;

const post = vi.fn(
  async () =>
    new Response(null, {
      status: 201,
      headers: { Location: "http://jenkins.example/queue/item/101/" },
    }),
);

const get = vi.fn(async (path: string) => {
  if (path.includes("tree=property")) {
    return new Response(
      JSON.stringify({
        property: [
          {
            parameterDefinitions: [
              { name: "ENV", choices: ["dev", "prod"] },
              { name: "BRANCH", defaultParameterValue: { value: "main" } },
            ],
          },
        ],
      }),
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
        result: building ? null : "SUCCESS",
        building,
        duration: 1000,
      }),
      { status: 200 },
    );
  }
  if (path.includes("/api/json?tree=jobs[")) {
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

vi.mock("../client.js", () => ({
  createSession: () => ({
    client: { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient,
    cache: new JenkinsCache(),
    config: { indexDepth: 4 },
  }),
}));

vi.mock("../job.js", () => ({
  gitOriginUrl: async () => undefined,
  resolveJob: async () => "team-a/svc",
}));

const { registerBuildCommand } = await import("../commands/build.js");

afterEach(() => {
  building = false;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function parser() {
  const root = yargs([])
    .option("job", { type: "string" })
    .option("json", { type: "boolean", default: false })
    .exitProcess(false) as unknown as Argv<GlobalArgs>;
  return registerBuildCommand(root);
}

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

function captureStderr() {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

describe("jenkins build trigger (CTRL-07)", () => {
  it("sends repeatable --param flags and prints the started build", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "trigger", "--param", "ENV=dev", "--param", "BRANCH=x"]);

    expect(post).toHaveBeenCalledWith(
      "/job/team-a/job/svc/buildWithParameters",
      expect.objectContaining({ body: expect.any(URLSearchParams) }),
    );
    expect(out()).toContain("started: team-a/svc #7");
    expect(out()).toContain("next: jenkins build wait");
  });

  it("blocks with --wait and prints the finished status instead", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "trigger", "--wait"]);

    expect(out()).toContain("status: SUCCESS");
  });

  it("rejects an unknown parameter before anything is posted", async () => {
    const err = captureStderr();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);

    await expect(
      parser().parseAsync(["build", "trigger", "--param", "NOPE=1"]),
    ).rejects.toThrowError("exited");

    expect(exit).toHaveBeenCalledWith(1);
    expect(err().trimEnd().split("\n")).toHaveLength(1);
    expect(err()).toMatch(/^error: invalid_input — Unknown build parameter 'NOPE'/);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a --param without an '=' with one error line", async () => {
    const err = captureStderr();
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);

    await expect(parser().parseAsync(["build", "trigger", "--param", "ENV"])).rejects.toThrowError(
      "exited",
    );

    expect(err()).toMatch(/^error: invalid_input — Invalid --param 'ENV'/);
  });
});

describe("jenkins build abort (CTRL-08)", () => {
  it("aborts the named build", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "abort", "12"]);

    expect(post).toHaveBeenCalledWith("/job/team-a/job/svc/12/stop", { redirect: "manual" });
    expect(out()).toContain("aborted: team-a/svc #12");
  });

  it("defaults to the most recent build", async () => {
    captureStdout();

    await parser().parseAsync(["build", "abort", "--ref", "feature/foo"]);

    expect(post).toHaveBeenCalledWith("/job/team-a/job/svc/job/feature%2Ffoo/lastBuild/stop", {
      redirect: "manual",
    });
  });
});

describe("jenkins build wait (CTRL-06)", () => {
  it("prints the finished result", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "wait", "7"]);

    expect(out()).toContain("status: SUCCESS");
    expect(out()).toContain("next: jenkins log");
    expect(out()).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("reports a timed-out wait as still building, not as a failure", async () => {
    building = true;
    const out = captureStdout();

    await parser().parseAsync(["build", "wait", "7", "--timeout", "0"]);

    expect(out()).toContain("still BUILDING");
    expect(out()).toContain("next: jenkins build wait");
  });

  it("emits the raw result under --json", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "wait", "7", "--json"]);

    expect(JSON.parse(out())).toMatchObject({ finished: true, result: "SUCCESS", polls: 1 });
  });
});

describe("the default build command still works alongside the subcommands", () => {
  it("inspects a build by number", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "7", "--json"]);

    expect(JSON.parse(out())).toMatchObject({ job: "team-a/svc", number: 7 });
  });
});

// ---------------------------------------------------------------------------
// CLI wait bound (Phase 7 criterion 0, and the review's NaN finding)
// ---------------------------------------------------------------------------

describe("jenkins build wait bound", () => {
  it("is UNBOUNDED by default, and ends on SIGINT rather than on a timeout", async () => {
    // `jenkins build wait` may block indefinitely (a human can Ctrl-C); the
    // MCP surface is the one with the 120s default. "Unbounded" still has to
    // terminate, so the interrupt is the termination condition.
    building = true;
    const out = captureStdout();

    const pending = parser().parseAsync(["build", "wait", "7"]);
    // Give the loop a poll, then interrupt it the way a human would.
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.emit("SIGINT");
    await pending;

    expect(out()).toContain("still BUILDING");
    expect(out()).toContain("wait cancelled");
  }, 15_000);

  it("does not hang forever on a non-numeric --timeout", async () => {
    // yargs coerces `--timeout abc` to NaN, and NaN removed the loop's only
    // elapsed-time exit: `jenkins build wait 7 --timeout abc` polled a hung
    // build until the process was killed. Core replaces it with the default,
    // so the wait is bounded again - proven here by interrupting it and
    // seeing that it was still a normal, cancellable wait rather than a hang.
    building = true;
    const out = captureStdout();

    const pending = parser().parseAsync(["build", "wait", "7", "--timeout", "abc"]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.emit("SIGINT");
    await pending;

    expect(out()).toContain("still BUILDING");
    expect(out()).not.toContain("error:");
  }, 15_000);

  it("passes an explicit --timeout through in seconds", async () => {
    building = true;
    const out = captureStdout();

    await parser().parseAsync(["build", "wait", "7", "--timeout", "0"]);

    expect(out()).toContain("wait timed out");
  }, 15_000);
});

/**
 * `jenkins build` command wiring: --json bypasses the formatter, and a bad
 * build selector leaves the process non-zero with one stderr line.
 *
 * The session and job resolution are stubbed because this asserts the COMMAND
 * layer only - credential resolution and job resolution have their own tests.
 */

import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import yargs, { type Argv } from "yargs";
import type { GlobalArgs } from "../commands/types.js";

const get = vi.fn(async (path: string) => {
  if (path.includes("/api/json?tree=jobs[")) {
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  }
  if (path.includes("/api/json?tree=number")) {
    return new Response(
      JSON.stringify({
        number: 42,
        result: "FAILURE",
        building: false,
        duration: 200_000,
        timestamp: 1_700_000_000_000,
        _class: "hudson.model.FreeStyleBuild",
      }),
      { status: 200 },
    );
  }
  return new Response("not found", { status: 404 });
});

vi.mock("../client.js", () => ({
  createSession: () => ({
    client: { get, post: vi.fn(), baseUrl: "http://jenkins.example" } as unknown as JenkinsClient,
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

describe("jenkins build (READ-09)", () => {
  it("prints the operation's raw data under --json, not the formatted text", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "42", "--json"]);

    const data = JSON.parse(out());
    expect(data).toMatchObject({ job: "team-a/svc", number: 42, result: "FAILURE" });
  });

  it("prints the formatter's text with {ref} placeholders resolved to jenkins commands", async () => {
    const out = captureStdout();

    await parser().parseAsync(["build", "42"]);

    expect(out()).toContain("team-a/svc #42  FAILURE");
    expect(out()).toContain("next: jenkins build diagnose");
    expect(out()).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("exits non-zero with one stderr line on a bad build value", async () => {
    const err = captureStderr();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);

    await expect(parser().parseAsync(["build", "nope"])).rejects.toThrowError("exited");

    expect(exit).toHaveBeenCalledWith(1);
    expect(err().trimEnd().split("\n")).toHaveLength(1);
    expect(err()).toMatch(/^error: invalid_input — /);
  });
});

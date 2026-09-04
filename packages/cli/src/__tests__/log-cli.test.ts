/**
 * `jenkins log` argument wiring only: that the flags reach `getBuildLog`, and
 * that a `--save-to` run prints the summary rather than the log body.
 */

import type { LogResult } from "@cuonghuunguyen/jenkins-core";
import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs, { type Argv } from "yargs";
import { registerLogCommand } from "../commands/log.js";
import type { GlobalArgs } from "../commands/types.js";

const getBuildLog = vi.hoisted(() => vi.fn());

vi.mock("@cuonghuunguyen/jenkins-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cuonghuunguyen/jenkins-core")>()),
  getBuildLog,
}));

// The command must not open a Jenkins connection or shell out to git.
vi.mock("../client.js", () => ({
  createSession: vi.fn(() => ({
    client: { get: vi.fn(), post: vi.fn(), baseUrl: "http://jenkins.example" } as JenkinsClient,
    cache: new JenkinsCache(),
    config: { indexDepth: 6 },
  })),
}));

vi.mock("../job.js", () => ({
  gitOriginUrl: vi.fn(async () => undefined),
  resolveJob: vi.fn(async (args: { job?: string }) => args.job ?? "team-a/svc"),
}));

const RESULT: LogResult = {
  job: "team-a/svc",
  selector: "1042",
  buildNumber: 1042,
  building: false,
  mode: "tail",
  totalLines: 3,
  segments: [{ startLine: 1, lines: ["a", "b", "c"] }],
  shownLines: 3,
};

function run(args: string[]): Promise<unknown> {
  const parser = registerLogCommand(yargs(args) as unknown as Argv<GlobalArgs>);
  return parser.parseAsync();
}

let stdout: string[];

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  getBuildLog.mockReset();
  getBuildLog.mockResolvedValue(RESULT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jenkins log", () => {
  it("passes --mode grep --pattern through to the operation", async () => {
    await run(["log", "1042", "--job", "team-a/svc", "--mode", "grep", "--pattern", "ERROR"]);

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        job: "team-a/svc",
        build: "1042",
        mode: "grep",
        pattern: "ERROR",
        depth: 6,
      }),
    );
  });

  it("maps --save-to and prints only the summary, never the log body", async () => {
    // `segments` is populated on purpose: with an empty body the assertion
    // below could not fail even if the formatter rendered the log first.
    getBuildLog.mockResolvedValue({
      ...RESULT,
      segments: [{ startLine: 1, lines: ["a", "b", "c"] }],
      shownLines: 3,
      saved: { savedTo: "out/x.log", bytes: 6, lines: 3 },
    } satisfies LogResult);

    await run(["log", "--job", "team-a/svc", "--save-to", "out/x.log"]);

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ saveTo: "out/x.log" }),
    );
    const text = stdout.join("");
    expect(text).toContain("saved: out/x.log");
    expect(text).not.toContain("\n  1  a");
  });

  it("defaults to mode=tail with clean on", async () => {
    await run(["log", "--job", "team-a/svc"]);

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: "tail", clean: true }),
    );
  });
});

describe("Phase 6 criterion 4 flags reach getBuildLog", () => {
  it("passes a negative --from/--to through unmodified, for core to resolve end-relatively", async () => {
    await run(["log", "1042", "--mode", "range", "--from", "-100", "--to", "-1"]);

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: "range", from: -100, to: -1 }),
    );
  });

  it("maps --max-matches onto maxMatches", async () => {
    await run(["log", "1042", "--mode", "grep", "--pattern", "ERROR", "--max-matches", "5"]);

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: "grep", pattern: "ERROR", maxMatches: 5 }),
    );
  });

  it("passes --context to mode=failed as the caller-controlled window", async () => {
    await run(["log", "1042", "--mode", "failed", "--context", "10"]);

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: "failed", context: 10 }),
    );
  });
});

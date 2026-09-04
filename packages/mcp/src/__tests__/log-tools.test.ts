/**
 * `jenkins_log` adapter contract only: the input schema and the one wire-name
 * mapping (`save_to` -> `saveTo`). What the modes compute is tested in core.
 */

import type { LogResult } from "@cuonghuunguyen/jenkins-core";
import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { registerLogTools } from "../tools/log.js";

const getBuildLog = vi.hoisted(() => vi.fn());

vi.mock("@cuonghuunguyen/jenkins-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cuonghuunguyen/jenkins-core")>()),
  getBuildLog,
}));

const RESULT: LogResult = {
  job: "team-a/svc",
  selector: "1042",
  buildNumber: 1042,
  building: false,
  mode: "tail",
  totalLines: 2,
  segments: [{ startLine: 1, lines: ["a", "b"] }],
  shownLines: 2,
};

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function register() {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description: string; inputSchema: Record<string, ZodType> }>();
  const server = {
    registerTool(
      name: string,
      config: { description: string; inputSchema: Record<string, ZodType> },
      handler: Handler,
    ) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };

  const client = {
    get: vi.fn(),
    post: vi.fn(),
    baseUrl: "http://jenkins.example",
  } as unknown as JenkinsClient;

  const names = registerLogTools(server as never, client, new JenkinsCache(), 6);
  return {
    names,
    config: configs.get("jenkins_log"),
    handler: handlers.get("jenkins_log") as Handler,
  };
}

beforeEach(() => {
  getBuildLog.mockReset();
  getBuildLog.mockResolvedValue(RESULT);
});

describe("jenkins_log registration", () => {
  it("registers exactly the one tool, described and schema'd", () => {
    const { names, config } = register();

    expect(names).toEqual(["jenkins_log"]);
    expect(config?.description).toContain("save_to");
    expect(Object.keys(config?.inputSchema ?? {})).toContain("mode");
  });

  it("rejects an unknown mode at the schema level", () => {
    const mode = register().config?.inputSchema.mode;

    expect(mode?.safeParse("grep").success).toBe(true);
    expect(mode?.safeParse("sideways").success).toBe(false);
  });
});

describe("jenkins_log handler", () => {
  it("maps the snake_case save_to wire field onto the operation's saveTo", async () => {
    const { handler } = register();

    await handler({ job: "team-a/svc", save_to: "out/x.log" });

    expect(getBuildLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ job: "team-a/svc", saveTo: "out/x.log", depth: 6 }),
    );
  });

  it("returns the core formatter's text with {ref} placeholders resolved", async () => {
    const { handler } = register();

    const result = await handler({ job: "team-a/svc", mode: "tail" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("next: jenkins_log");
    expect(result.content[0]?.text).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

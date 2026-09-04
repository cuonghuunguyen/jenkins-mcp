/**
 * `jenkins job [ref]` command tests.
 *
 * `createSession` is mocked so the command runs against a fake client instead
 * of resolving real credentials and opening a real connection - the CLI's own
 * job here is argument plumbing and the `--json` switch, nothing more.
 */

import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import yargs, { type Argv } from "yargs";
import { registerJobCommand } from "../commands/job.js";
import type { GlobalArgs } from "../commands/types.js";

const state: { session: unknown } = { session: undefined };

vi.mock("../client.js", () => ({ createSession: () => state.session }));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const INDEX = {
  jobs: [
    {
      fullName: "team-a/svc",
      name: "svc",
      _class: "hudson.model.FreeStyleProject",
      color: "blue",
    },
  ],
};

const JOB = {
  name: "svc",
  fullName: "explicit/job",
  buildable: true,
  _class: "hudson.model.FreeStyleProject",
  property: [],
  builds: [{ number: 3, result: "SUCCESS", building: false, timestamp: 1, duration: 1000 }],
};

function session() {
  const get = vi.fn(async (path: string) => {
    const body = path.includes("tree=jobs[") ? INDEX : JOB;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  state.session = {
    client: { get, post: vi.fn(), baseUrl: "http://jenkins.example" } as unknown as JenkinsClient,
    cache: new JenkinsCache(),
    config: { indexDepth: 6 },
  };
  return get;
}

/** A root parser carrying only the globals the command actually reads. */
function parser(): Argv<GlobalArgs> {
  const root = yargs([])
    .option("job", { type: "string" })
    .option("json", { type: "boolean", default: false })
    .exitProcess(false) as unknown as Argv<GlobalArgs>;
  return registerJobCommand(root);
}

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("jenkins job (ARCH-02)", () => {
  it("lets --job win over JENKINS_JOB", async () => {
    process.env.JENKINS_JOB = "env/job";
    const get = session();
    const out = captureStdout();

    await parser().parseAsync(["job", "--job", "explicit/job"]);
    out.restore();

    const paths = get.mock.calls.map(([path]) => path);
    expect(paths.some((path) => path.includes("/job/explicit/job/job/api/json"))).toBe(true);
    expect(paths.some((path) => path.includes("env/job"))).toBe(false);
  });

  it("passes the ref positional through to the operation", async () => {
    const get = session();
    const out = captureStdout();

    await parser().parseAsync(["job", "main", "--job", "explicit/job"]);
    out.restore();

    expect(get.mock.calls.some(([path]) => path.includes("/job/explicit/job/job/job/main/"))).toBe(
      true,
    );
  });

  it("emits the raw operation result under --json, without running the formatter", async () => {
    session();
    const out = captureStdout();

    await parser().parseAsync(["job", "--job", "explicit/job", "--json"]);
    const text = out.text();
    out.restore();

    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe("job");
    expect(parsed.builds).toHaveLength(1);
    // The formatter's table headers must not appear - --json is raw data only.
    expect(text).not.toContain("builds (1)");
  });

  it("renders the core formatter's text otherwise, with placeholders resolved", async () => {
    session();
    const out = captureStdout();

    await parser().parseAsync(["job", "--job", "explicit/job"]);
    const text = out.text();
    out.restore();

    expect(text).toContain("builds (1)");
    expect(text).toContain("next: jenkins build");
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

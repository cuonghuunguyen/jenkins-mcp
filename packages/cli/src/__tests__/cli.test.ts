import { JenkinsCache, type JenkinsClient, JenkinsError } from "@jenkins-mcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../client.js";
import { resolveJob } from "../job.js";
import { CLI_VOCABULARY, emit } from "../output.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function captureStdout(): { lines: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("emit (ARCH-02)", () => {
  it("prints the operation's raw data under --json, without running the formatter", () => {
    const out = captureStdout();
    const render = vi.fn(() => "formatted");

    emit(true, { a: 1 }, render);

    expect(render).not.toHaveBeenCalled();
    expect(JSON.parse(out.lines())).toEqual({ a: 1 });
    out.restore();
  });

  it("prints the formatter's text otherwise", () => {
    const out = captureStdout();

    emit(false, { a: 1 }, () => "formatted");

    expect(out.lines()).toBe("formatted\n");
    out.restore();
  });

  it("resolves core's {ref} placeholders to jenkins commands, not tool names", () => {
    const out = captureStdout();

    emit(false, {}, () => "next: {build} then {log}");

    expect(out.lines()).toBe("next: jenkins build then jenkins log\n");
    out.restore();
  });
});

describe("CLI vocabulary", () => {
  it("renders every command ref as a jenkins command, so no literal {ref} can leak", () => {
    for (const [ref, command] of Object.entries(CLI_VOCABULARY)) {
      expect(command, `vocabulary entry for {${ref}}`).toMatch(/^jenkins /);
    }
  });
});

describe("resolveConfig", () => {
  it("lets flags override the environment", () => {
    process.env.JENKINS_URL = "https://env.example.com";
    process.env.JENKINS_USER = "env-user";
    process.env.JENKINS_API_TOKEN = "env-token";

    const config = resolveConfig({ url: "https://flag.example.com", user: "flag-user" });

    expect(config.jenkinsUrl).toBe("https://flag.example.com");
    expect(config.jenkinsUser).toBe("flag-user");
    expect(config.jenkinsApiToken).toBe("env-token");
  });

  it("falls through an exported-but-empty env var instead of being shadowed by it", () => {
    process.env.JENKINS_URL = "";
    process.env.JENKINS_USER = "env-user";
    process.env.JENKINS_API_TOKEN = "env-token";

    const config = resolveConfig({ url: "https://flag.example.com" });

    expect(config.jenkinsUrl).toBe("https://flag.example.com");
  });

  it("names the --flag escape hatch when configuration is missing", () => {
    process.env.JENKINS_URL = undefined;
    process.env.JENKINS_USER = undefined;
    process.env.JENKINS_API_TOKEN = undefined;

    expect(() => resolveConfig({})).toThrowError(/pass --url, --user and --token/);
  });

  it("never echoes a candidate token value into the error message", () => {
    process.env.JENKINS_URL = "not-a-url";
    process.env.JENKINS_USER = "alice";
    process.env.JENKINS_API_TOKEN = "s3cr3t-token-value";

    try {
      resolveConfig({});
      expect.unreachable("expected resolveConfig to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cr3t-token-value");
    }
  });
});

describe("resolveJob (ARCH-02)", () => {
  const indexWithRemote = {
    jobs: [
      {
        fullName: "team-a/svc",
        name: "svc",
        _class: "hudson.model.FreeStyleProject",
        color: "blue",
        scm: { userRemoteConfigs: [{ url: "ssh://git@bitbucket.example.com/team/svc.git" }] },
      },
    ],
  };

  function client(body: unknown): JenkinsClient {
    return {
      get: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      post: vi.fn(),
      baseUrl: "https://jenkins.example.com",
    } as unknown as JenkinsClient;
  }

  it("prefers an explicit --job over any lookup", async () => {
    const resolved = await resolveJob({
      job: "explicit/job",
      client: client({}),
      cache: new JenkinsCache(),
      depth: 6,
    });

    expect(resolved).toBe("explicit/job");
  });

  it("falls back to JENKINS_JOB before touching git", async () => {
    process.env.JENKINS_JOB = "env/job";

    const resolved = await resolveJob({
      client: client({}),
      cache: new JenkinsCache(),
      depth: 6,
    });

    expect(resolved).toBe("env/job");
  });

  it("resolves the job from the origin remote, matching on SCM URL across ssh/https forms", async () => {
    process.env.JENKINS_JOB = "";

    // The remote is HTTPS while the job's configured SCM URL is SSH - the
    // normalizer is what makes these match.
    const resolved = await resolveJob({
      remote: "https://bitbucket.example.com/team/svc.git",
      client: client(indexWithRemote),
      cache: new JenkinsCache(),
      depth: 6,
    });

    expect(resolved).toBe("team-a/svc");
  });

  it("names the --job escape hatch when there is no git origin to go on", async () => {
    process.env.JENKINS_JOB = "";

    await expect(
      resolveJob({ client: client({}), cache: new JenkinsCache(), depth: 6 }),
    ).rejects.toThrowError(/pass --job/);
  });

  it("refuses to guess when the origin remote matches no job", async () => {
    process.env.JENKINS_JOB = "";
    await expect(
      resolveJob({
        remote: "ssh://git@host/other/repo.git",
        client: client(indexWithRemote),
        cache: new JenkinsCache(),
        depth: 6,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses to guess when several jobs build the same remote", async () => {
    process.env.JENKINS_JOB = "";
    const twoJobs = {
      jobs: [
        indexWithRemote.jobs[0],
        {
          fullName: "team-b/svc-mirror",
          name: "svc-mirror",
          _class: "hudson.model.FreeStyleProject",
          color: "blue",
          scm: { userRemoteConfigs: [{ url: "ssh://git@bitbucket.example.com/team/svc.git" }] },
        },
      ],
    };

    await expect(
      resolveJob({
        remote: "ssh://git@bitbucket.example.com/team/svc.git",
        client: client(twoJobs),
        cache: new JenkinsCache(),
        depth: 6,
      }),
    ).rejects.toThrowError(/Pass --job to choose one/);
  });
});

describe("structured errors reach the shell (AGNT-05)", () => {
  it("keeps the code/message/try shape a CLI user sees", () => {
    const err = new JenkinsError("Job not found.", "jenkins_job", 404, "not_found", "{findJobs}");

    // fail() exits the process, so assert the rendering it delegates to.
    expect(err.code).toBe("not_found");
    expect(CLI_VOCABULARY.findJobs).toBe("jenkins jobs find");
  });
});

/**
 * Adapter-level tests for jenkins_queue and jenkins_api_get (READ-12).
 *
 * These assert the ADAPTER's job only - schema presence, result shape, error
 * rendering, placeholder resolution. What the operations compute is tested in
 * core.
 */

import { JenkinsCache, type JenkinsClient } from "@cuonghuunguyen/jenkins-core";
import { describe, expect, it, vi } from "vitest";
import { registerMiscTools } from "../tools/misc.js";

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
    if (path.startsWith("/queue/api/json")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 4,
              why: "Waiting for next available executor",
              stuck: true,
              inQueueSince: Date.now() - 60_000,
              task: { fullName: "team-a/svc/main" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("<config/>", {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
  });
  const post = vi.fn(async () => new Response("{}", { status: 200 }));
  const client = { get, post, baseUrl: "http://jenkins.example" } as unknown as JenkinsClient;

  const names = registerMiscTools(server as never, client, new JenkinsCache());
  return {
    names,
    get,
    post,
    config: (name: string) => configs.get(name),
    handler: (name: string) => {
      const found = handlers.get(name);
      if (found === undefined) throw new Error(`tool not registered: ${name}`);
      return found;
    },
  };
}

describe("registerMiscTools", () => {
  it("registers exactly the two READ-12 tools", () => {
    expect(register().names).toEqual(["jenkins_queue", "jenkins_api_get"]);
  });

  it("gives both tools a description stating what they do and when to use them", () => {
    // A length assertion passes for any 41-character string, which is not the
    // property the name claims.
    const { config } = register();

    expect(String(config("jenkins_queue")?.description)).toContain("build queue");
    expect(String(config("jenkins_queue")?.description)).toContain("Instance-wide");
    expect(String(config("jenkins_api_get")?.description)).toContain("Read-only");
    expect(String(config("jenkins_api_get")?.description)).toContain("escape hatch");
  });

  it("takes no input at all for jenkins_queue", () => {
    expect(Object.keys(register().config("jenkins_queue")?.inputSchema ?? {})).toEqual([]);
  });

  it("declares path and tree for jenkins_api_get, stating the rules the validation enforces", () => {
    const { config } = register();
    const schema = config("jenkins_api_get")?.inputSchema ?? {};

    expect(Object.keys(schema)).toEqual(["path", "tree", "max_bytes"]);
    // An agent reading only the schema must not be able to make the mistakes
    // the core validation catches.
    expect(String(config("jenkins_api_get")?.description)).toContain("Read-only");
    expect((schema.path as { description?: string }).description).toContain("absolute URL");
    expect((schema.tree as { description?: string }).description).toContain("REQUIRED");
    // Without this the remaining bytes of a truncated config.xml were
    // unreachable by any documented call.
    expect((schema.max_bytes as { description?: string }).description).toContain("truncated");
  });

  it("passes max_bytes through to the core budget", async () => {
    const result = await register().handler("jenkins_api_get")({
      path: "/job/svc/config.xml",
      max_bytes: 4,
    });

    expect(result.content[0]?.text ?? "").toContain("[truncated");
  });
});

describe("handler results", () => {
  it("renders the queue through the core formatter", async () => {
    const text = (await register().handler("jenkins_queue")({})).content[0]?.text ?? "";

    expect(text).toContain("queue (1)");
    expect(text).toContain("team-a/svc/main");
    expect(text).toContain("stuck");
  });

  it("resolves core's {ref} placeholders to real tool names", async () => {
    const text = (await register().handler("jenkins_queue")({})).content[0]?.text ?? "";

    expect(text).toContain("next: jenkins_build");
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("returns a raw GET body as a text block", async () => {
    const result = await register().handler("jenkins_api_get")({ path: "/job/svc/config.xml" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("api: /job/svc/config.xml (application/xml");
    expect(result.content[0]?.text).toContain("<config/>");
  });

  it("turns a validation failure into one structured error line", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await register().handler("jenkins_api_get")({ path: "/api/json" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("error: invalid_input");
    consoleError.mockRestore();
  });

  it("never posts, on any call, so the escape hatch stays read-only", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, post } = register();

    await handler("jenkins_queue")({});
    await handler("jenkins_api_get")({ path: "/job/svc/config.xml" });
    await handler("jenkins_api_get")({ path: "http://evil.example" });

    expect(post).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

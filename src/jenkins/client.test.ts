/**
 * Vitest coverage for JenkinsClient — Basic auth + crumb/cookie attach +
 * re-fetch-once-on-403 (CONN-01, CONN-02, D-03). `fetch` is mocked
 * throughout; this suite never hits a live Jenkins instance. The live
 * write-shaped round-trip proof is deferred to plan 01-07.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { createJenkinsClient } from "./client.js";

const config: Config = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "user",
  jenkinsApiToken: "token",
};

const EXPECTED_AUTH = `Basic ${Buffer.from("user:token").toString("base64")}`;
const CRUMB_ISSUER_URL = "https://jenkins.example.com/crumbIssuer/api/json";

function crumbIssuerResponse(opts: { ok?: boolean; cookies?: string[] } = {}): Response {
  const headers = new Headers();
  for (const cookie of opts.cookies ?? ["JSESSIONID.abc=xyz; Path=/; HttpOnly"]) {
    headers.append("set-cookie", cookie);
  }
  return {
    ok: opts.ok ?? true,
    headers,
    json: async () => ({ crumbRequestField: "Jenkins-Crumb", crumb: "crumb-value" }),
  } as unknown as Response;
}

function headersFromCall(call: unknown[]): Headers {
  const init = call[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

describe("createJenkinsClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches a Basic auth Authorization header derived from config on every request (CONN-01)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CRUMB_ISSUER_URL) return crumbIssuerResponse();
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJenkinsClient(config);
    await client.get("/me/api/json");
    await client.post("/me/api/json");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      expect(headersFromCall(call).get("Authorization")).toBe(EXPECTED_AUTH);
    }
  });

  it("attaches the crumb header and Cookie on POST when a crumb is held (CONN-02)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CRUMB_ISSUER_URL) return crumbIssuerResponse();
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJenkinsClient(config);
    await client.post("/me/api/json");

    const postCall = fetchMock.mock.calls.find(
      (call) => (call[0] as string) === "https://jenkins.example.com/me/api/json",
    );
    expect(postCall).toBeDefined();
    const headers = headersFromCall(postCall as unknown[]);
    expect(headers.get("Jenkins-Crumb")).toBe("crumb-value");
    expect(headers.get("Cookie")).toBe("JSESSIONID.abc=xyz");
  });

  it("on a crumb-specific 403, re-fetches the crumb exactly once and retries exactly once (D-03)", async () => {
    let realCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CRUMB_ISSUER_URL) return crumbIssuerResponse();
      realCallCount += 1;
      if (realCallCount === 1) {
        return new Response("No valid crumb was included in the request", { status: 403 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJenkinsClient(config);
    const res = await client.post("/me/api/json");

    expect(res.status).toBe(200);
    expect(realCallCount).toBe(2); // original attempt + exactly one retry
    const crumbCalls = fetchMock.mock.calls.filter(
      (call) => (call[0] as string) === CRUMB_ISSUER_URL,
    );
    expect(crumbCalls.length).toBe(2); // initial crumb fetch + one re-fetch after invalidate
  });

  it("returns after exactly one retry on a persistent crumb 403 — never a loop (D-03)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CRUMB_ISSUER_URL) return crumbIssuerResponse();
      return new Response("No valid crumb was included in the request", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJenkinsClient(config);
    const res = await client.post("/me/api/json");

    expect(res.status).toBe(403);
    const realCalls = fetchMock.mock.calls.filter(
      (call) => (call[0] as string) === "https://jenkins.example.com/me/api/json",
    );
    expect(realCalls.length).toBe(2); // original + exactly one retry, never more
  });

  it("sends a token+cookie POST without throwing when the crumb issuer is unavailable (D-03 tolerance)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CRUMB_ISSUER_URL) return crumbIssuerResponse({ ok: false });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJenkinsClient(config);
    const res = await client.post("/me/api/json");

    expect(res.status).toBe(200);
    const postCall = fetchMock.mock.calls.find(
      (call) => (call[0] as string) === "https://jenkins.example.com/me/api/json",
    );
    const headers = headersFromCall(postCall as unknown[]);
    expect(headers.get("Authorization")).toBe(EXPECTED_AUTH);
    expect(headers.has("Jenkins-Crumb")).toBe(false);
  });
});

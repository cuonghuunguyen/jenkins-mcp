/**
 * Vitest coverage for CrumbCache — lazy crumb fetch + getSetCookie() cookie
 * capture (CONN-02, D-03). `fetch` is mocked throughout; this suite never
 * hits a live Jenkins instance.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CrumbCache } from "./auth.js";

const BASE_URL = "https://jenkins.example.com";
const AUTH_HEADER = "Basic dXNlcjp0b2tlbg==";

/**
 * Builds a fake crumbIssuer fetch response. Uses a real `Headers` instance
 * so `getSetCookie()` behaves exactly as it would against a live response
 * (Node/undici special-cases "set-cookie" to never collapse multiple
 * values, regardless of whether they were appended manually or received
 * over the wire).
 */
function crumbIssuerResponse(
  opts: { ok?: boolean; cookies?: string[]; body?: unknown } = {},
): Response {
  const headers = new Headers();
  for (const cookie of opts.cookies ?? []) {
    headers.append("set-cookie", cookie);
  }
  return {
    ok: opts.ok ?? true,
    headers,
    json: async () => opts.body ?? { crumbRequestField: "Jenkins-Crumb", crumb: "abc123" },
  } as unknown as Response;
}

describe("CrumbCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches /crumbIssuer/api/json and returns field/value/cookie", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(crumbIssuerResponse({ cookies: ["JSESSIONID.abc=xyz; Path=/; HttpOnly"] }));
    vi.stubGlobal("fetch", fetchMock);

    const cache = new CrumbCache();
    const state = await cache.get(BASE_URL, AUTH_HEADER);

    expect(state).toEqual({
      field: "Jenkins-Crumb",
      value: "abc123",
      cookie: "JSESSIONID.abc=xyz",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/crumbIssuer/api/json`,
      expect.objectContaining({ headers: { Authorization: AUTH_HEADER } }),
    );
  });

  it("builds the cookie from getSetCookie(), joining multiple Set-Cookie headers with '; '", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      crumbIssuerResponse({
        cookies: ["JSESSIONID.abc=xyz; Path=/; HttpOnly", "OTHER=val2; Secure"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cache = new CrumbCache();
    const state = await cache.get(BASE_URL, AUTH_HEADER);

    expect(state?.cookie).toBe("JSESSIONID.abc=xyz; OTHER=val2");
  });

  it("caches the crumb: a second get() call does not re-fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(crumbIssuerResponse());
    vi.stubGlobal("fetch", fetchMock);

    const cache = new CrumbCache();
    const first = await cache.get(BASE_URL, AUTH_HEADER);
    const second = await cache.get(BASE_URL, AUTH_HEADER);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null (tolerated) when the crumb issuer responds non-ok (e.g. 404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(crumbIssuerResponse({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    const cache = new CrumbCache();
    const state = await cache.get(BASE_URL, AUTH_HEADER);

    expect(state).toBeNull();
  });

  it("returns null (tolerated) when fetch rejects with a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const cache = new CrumbCache();
    const state = await cache.get(BASE_URL, AUTH_HEADER);

    expect(state).toBeNull();
  });

  it("invalidate() clears the cache so the next get() re-fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(crumbIssuerResponse());
    vi.stubGlobal("fetch", fetchMock);

    const cache = new CrumbCache();
    await cache.get(BASE_URL, AUTH_HEADER);
    cache.invalidate();
    await cache.get(BASE_URL, AUTH_HEADER);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

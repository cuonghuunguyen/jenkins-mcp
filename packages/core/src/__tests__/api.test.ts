/**
 * Raw-GET escape hatch tests (READ-12).
 *
 * One test per validation rule, plus the assertion that keeps the tool
 * read-only: `client.post` is never reached.
 */

import { describe, expect, it, vi } from "vitest";
import type { JenkinsClient } from "../client.js";
import { formatApiGetResult } from "../format/api.js";
import { API_GET_MAX_BYTES, apiGet } from "../operations/api.js";

/** A client that answers every GET with `text`, so the path itself is the subject. */
function client(text = "<config/>", contentType = "application/xml", status = 200) {
  const get = vi.fn(
    async (path: string) =>
      new Response(text, { status, headers: { "content-type": contentType }, statusText: path }),
  );
  const post = vi.fn(async () => new Response("{}", { status: 200 }));
  return {
    client: { get, post, baseUrl: "https://jenkins.example.com" } as unknown as JenkinsClient,
    get,
    post,
  };
}

describe("apiGet validation (SSRF and context-budget guards)", () => {
  it("rejects a path without a leading slash", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "config.xml" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an absolute URL, which would send the credentials to another host", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "http://evil.example/steal" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a protocol-relative //host path", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "//evil.example/steal" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a '..' segment", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "/job/a/../../etc/passwd" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  /**
   * The reviewer's own reproduction, asserted at the `client.get` boundary: the
   * defect was that validation read the RAW path while `fetch`'s URL parser
   * resolved the encoded dot segments, so what left the process
   * (`https://ci/secret`, Authorization attached) was never the string that was
   * checked. A test that only asserts the rejection code would have passed on
   * the broken code for `..`, so every case here also asserts that nothing was
   * requested.
   */
  it("rejects percent-encoded dot segments, which fetch would resolve after validation", async () => {
    const { client: c, get } = client();

    for (const path of ["/%2e%2e/%2e%2e/secret", "/job/a/%2E%2E/etc/passwd", "/%2e/x"]) {
      await expect(apiGet(c, { path })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a '/./' segment, which bypassed the mandatory-tree rule", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "/queue/api/./json" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("applies the mandatory-tree rule to the path a servlet container would route", async () => {
    const { client: c, get } = client();

    // Jetty compacts `//` and strips `;name=value` path parameters before
    // Stapler sees the request, so both forms reach the same api/json endpoint.
    for (const path of ["/queue/api//json", "/queue/api/json;x=y"]) {
      await expect(apiGet(c, { path })).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("tree is required"),
      });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("requires tree for api/xml and api/python, which dump the same object graph", async () => {
    const { client: c, get } = client();

    for (const path of ["/queue/api/xml", "/api/python"]) {
      await expect(apiGet(c, { path })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a '#' fragment, which would silently truncate the path that is sent", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "/job/svc/config.xml#frag" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("sends the canonicalized path, so the request equals the string validated", async () => {
    const { client: c, get } = client();

    await apiGet(c, { path: "/job/a b/config.xml" });

    expect(get.mock.calls[0]?.[0]).toBe("/job/a%20b/config.xml");
  });

  it("rejects an embedded query string, which could bypass the mandatory tree rule", async () => {
    const { client: c, get } = client();

    await expect(apiGet(c, { path: "/api/json?tree=jobs[name]" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("requires tree for an api/json path, naming the rule and an example", async () => {
    const { client: c } = client();

    await expect(apiGet(c, { path: "/api/json" })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("tree is required"),
      tryHint: expect.stringContaining("tree='jobs[fullName,color]'"),
    });
  });

  it("requires tree for a trailing-slash api/json path too", async () => {
    const { client: c } = client();

    await expect(apiGet(c, { path: "/job/svc/api/json/" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("treats a blank tree as absent", async () => {
    const { client: c } = client();

    await expect(apiGet(c, { path: "/api/json", tree: "  " })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("accepts an api/json path with a tree, encoding it into the query", async () => {
    const { client: c, get } = client('{"jobs":[]}', "application/json");

    const data = await apiGet(c, { path: "/api/json", tree: "jobs[fullName]" });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toBe("/api/json?tree=jobs%5BfullName%5D");
    expect(data.body).toBe('{"jobs":[]}');
    expect(data.contentType).toBe("application/json");
  });

  it("accepts a non-api/json path without a tree", async () => {
    const { client: c, get } = client();

    const data = await apiGet(c, { path: "/job/svc/config.xml" });

    expect(get).toHaveBeenCalledTimes(1);
    expect(data.path).toBe("/job/svc/config.xml");
    expect(data.body).toBe("<config/>");
    expect(data.truncated).toBe(false);
  });
});

describe("apiGet", () => {
  it("never writes: post is not called on any path", async () => {
    const { client: c, post } = client();

    await apiGet(c, { path: "/job/svc/config.xml" });
    await apiGet(c, { path: "/api/json", tree: "jobs[fullName]" }).catch(() => undefined);
    await apiGet(c, { path: "http://evil.example" }).catch(() => undefined);

    expect(post).not.toHaveBeenCalled();
  });

  it("flags an over-budget body as truncated for --json callers", async () => {
    const { client: c } = client("x".repeat(200));

    const data = await apiGet(c, { path: "/job/svc/config.xml", maxBytes: 100 });

    expect(data.bytes).toBe(200);
    expect(data.truncated).toBe(true);
    expect(data.maxBytes).toBe(100);
  });

  it("defaults the budget to 64 KiB", async () => {
    const { client: c } = client();

    expect((await apiGet(c, { path: "/x.txt" })).maxBytes).toBe(API_GET_MAX_BYTES);
    expect(API_GET_MAX_BYTES).toBe(65_536);
  });

  it("normalizes a 404 rather than returning the error body", async () => {
    const { client: c } = client("not found", "text/plain", 404);

    await expect(apiGet(c, { path: "/nope.xml" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("formatApiGetResult", () => {
  it("heads the body with the path, content type and byte count", () => {
    const text = formatApiGetResult({
      path: "/job/svc/config.xml",
      contentType: "application/xml",
      body: "<config/>",
      bytes: 9,
      truncated: false,
      maxBytes: API_GET_MAX_BYTES,
    });

    expect(text).toContain("api: /job/svc/config.xml (application/xml, 9 bytes)");
    expect(text).toContain("<config/>");
    expect(text).toContain("next: {findJobs}");
  });

  it("caps an over-budget body and names the narrower request", () => {
    const text = formatApiGetResult({
      path: "/api/json?tree=jobs%5BfullName%5D",
      contentType: "application/json",
      body: "y".repeat(200),
      bytes: 200,
      truncated: true,
      maxBytes: 100,
    });

    expect(text).toContain("[truncated 100 of 200 bytes");
    expect(text).toContain("narrower tree=");
  });

  it("names max_bytes, not tree=, when the capped body is not an api/json read", () => {
    // tree= narrows nothing on a config.xml, so naming it left the remaining
    // bytes unreachable by any documented call.
    const text = formatApiGetResult({
      path: "/job/svc/config.xml",
      contentType: "application/xml",
      body: "y".repeat(200),
      bytes: 200,
      truncated: true,
      maxBytes: 100,
    });

    expect(text).toContain("[truncated 100 of 200 bytes");
    expect(text).toContain("max_bytes above 200");
    expect(text).not.toContain("narrower tree=");
  });

  it("caps on a codepoint boundary rather than emitting U+FFFD", () => {
    // "é" is two bytes; a cap of 5 lands inside the third one.
    const text = formatApiGetResult({
      path: "/x.txt",
      contentType: "text/plain",
      body: "éééé",
      bytes: 8,
      truncated: true,
      maxBytes: 5,
    });

    expect(text).not.toContain("\uFFFD");
    expect(text).toContain("[truncated 4 of 8 bytes");
  });

  it("emits no literal tool name, so each adapter owns the vocabulary", () => {
    const text = formatApiGetResult({
      path: "/x.txt",
      contentType: "text/plain",
      body: "x",
      bytes: 1,
      truncated: false,
      maxBytes: API_GET_MAX_BYTES,
    });

    expect(text).not.toMatch(/jenkins_/);
  });
});

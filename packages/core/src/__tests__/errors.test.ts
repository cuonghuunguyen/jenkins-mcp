/**
 * Vitest coverage for the centralized error-normalization + secret-redaction
 * module (CONN-03, RESEARCH.md Pitfall 4).
 */

import { describe, expect, it } from "vitest";
import { JenkinsError, normalizeError, redact } from "../errors.js";

const FAKE_TOKEN = "sk-fake-secret-token-12345";
const FAKE_COOKIE = "JSESSIONID.abc123=deadbeefcafefeed";
const FAKE_CRUMB = "crumb-value-should-never-leak";

describe("normalizeError", () => {
  it("maps a 401 response to a distinct, actionable auth-failure message", () => {
    const res = new Response(null, { status: 401 });
    const err = normalizeError(res, "jenkins_whoami");

    expect(err).toBeInstanceOf(JenkinsError);
    expect(err.status).toBe(401);
    expect(err.operation).toBe("jenkins_whoami");
    expect(err.message.toLowerCase()).toContain("authenticat");
    expect(err.message).toContain("JENKINS_USER");
    expect(err.message).toContain("JENKINS_API_TOKEN");
  });

  it("maps a 403 response to a distinct insufficient-permissions message", () => {
    const res = new Response(null, { status: 403 });
    const err = normalizeError(res, "jenkins_whoami");

    expect(err.status).toBe(403);
    expect(err.message.toLowerCase()).toContain("permission");
  });

  it("produces distinct messages for 401 vs 403", () => {
    const authErr = normalizeError(new Response(null, { status: 401 }), "op");
    const permErr = normalizeError(new Response(null, { status: 403 }), "op");

    expect(authErr.message).not.toBe(permErr.message);
  });

  it("maps a thrown network/connection error to a connection-failure message", () => {
    const thrown = new TypeError("fetch failed");
    const err = normalizeError(thrown, "jenkins_whoami");

    expect(err.status).toBeUndefined();
    expect(err.message.toLowerCase()).toContain("connect");
    expect(err.message).toContain("JENKINS_URL");
  });

  it("never contains a fake token substring in a 401 message, even when request headers carried one", () => {
    // Simulate what a call site would have used to build the request that
    // failed — normalizeError must never receive or interpolate these raw
    // headers; it only ever sees status + operation.
    const basicAuth = Buffer.from(`user:${FAKE_TOKEN}`).toString("base64");
    void new Headers({ Authorization: `Basic ${basicAuth}`, Cookie: FAKE_COOKIE });

    const res = new Response(null, { status: 401 });
    const err = normalizeError(res, "jenkins_whoami");

    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.message).not.toContain(basicAuth);
    expect(err.message).not.toContain(FAKE_COOKIE);
  });

  it("never interpolates a raw Response/Error object into the message string", () => {
    const res = new Response(null, { status: 500, statusText: "top secret detail" });
    const err = normalizeError(res, "op");
    expect(err.message).not.toContain("top secret detail");

    const thrown = new Error("connect ECONNREFUSED 10.0.0.1:8080 leaked-detail");
    const connErr = normalizeError(thrown, "op");
    expect(connErr.message).not.toContain("leaked-detail");
  });

  it("maps a TimeoutError (e.g. from AbortSignal.timeout) to an actionable, statusless JenkinsError", () => {
    const timeoutErr = new DOMException("boom", "TimeoutError");
    const err = normalizeError(timeoutErr, "jenkins_bash:hydrate-dir");

    expect(err).toBeInstanceOf(JenkinsError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).toContain("JENKINS_REQUEST_TIMEOUT_MS");
  });

  it("maps an AbortError the same way as a TimeoutError", () => {
    const abortErr = new DOMException("boom", "AbortError");
    const err = normalizeError(abortErr, "jenkins_bash:skeleton");

    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).toContain("JENKINS_REQUEST_TIMEOUT_MS");
  });

  it("never leaks a TimeoutError's own message into the normalized timeout message", () => {
    const secretDetail = "leaked-timeout-detail sk-fake-secret-token-99999";
    const timeoutErr = new DOMException(secretDetail, "TimeoutError");
    const err = normalizeError(timeoutErr, "op");

    expect(err.message).not.toContain(secretDetail);
    expect(err.message).not.toContain("leaked-timeout-detail");
  });
});

describe("redact", () => {
  it("replaces Authorization, Cookie, and crumb header values with a fixed placeholder", () => {
    const headers = new Headers({
      Authorization: `Basic ${Buffer.from(`user:${FAKE_TOKEN}`).toString("base64")}`,
      Cookie: FAKE_COOKIE,
      "Jenkins-Crumb": FAKE_CRUMB,
      "Content-Type": "application/json",
    });

    const redacted = redact(headers);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_COOKIE);
    expect(serialized).not.toContain(FAKE_CRUMB);
    // Allowlisted, non-secret header is preserved. Note: the native Headers
    // class normalizes header names to lowercase per the Fetch spec.
    expect(redacted["content-type"]).toBe("application/json");
  });

  it("redacts an unknown header name too (allowlist, not denylist)", () => {
    const redacted = redact({ "X-Totally-Unknown-Header": FAKE_TOKEN });
    expect(JSON.stringify(redacted)).not.toContain(FAKE_TOKEN);
  });

  it("leaves no original secret substring anywhere in the redacted output", () => {
    const redacted = redact([
      ["authorization", `Bearer ${FAKE_TOKEN}`],
      ["cookie", FAKE_COOKIE],
    ]);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_COOKIE);
  });
});

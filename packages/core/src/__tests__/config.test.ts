import { describe, expect, it } from "vitest";
import { validateConfig } from "../config.js";

describe("validateConfig", () => {
  it("returns a typed Config, with defaulted tuning knobs, when the three required env vars are valid", () => {
    const result = validateConfig({
      JENKINS_URL: "https://jenkins.example.com",
      JENKINS_USER: "alice",
      JENKINS_API_TOKEN: "s3cr3t-token-value",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        jenkinsUrl: "https://jenkins.example.com",
        jenkinsUser: "alice",
        jenkinsApiToken: "s3cr3t-token-value",
        indexDepth: 6,
        requestTimeoutMs: 60_000,
        readonly: false,
      });
    }
  });

  it("names the offending field when JENKINS_URL is missing", () => {
    const result = validateConfig({
      JENKINS_URL: undefined,
      JENKINS_USER: "alice",
      JENKINS_API_TOKEN: "s3cr3t-token-value",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain("jenkinsUrl");
    }
  });

  it("names the offending field when JENKINS_URL is malformed", () => {
    const result = validateConfig({
      JENKINS_URL: "not-a-valid-url",
      JENKINS_USER: "alice",
      JENKINS_API_TOKEN: "s3cr3t-token-value",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain("jenkinsUrl");
    }
  });

  it("never echoes the supplied token value in the failure message", () => {
    const secretToken = "super-secret-token-do-not-leak-XYZ123";
    const result = validateConfig({
      JENKINS_URL: undefined,
      JENKINS_USER: "alice",
      JENKINS_API_TOKEN: secretToken,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).not.toContain(secretToken);
    }
  });

  it("names jenkinsApiToken when the token is missing, without leaking anything", () => {
    const result = validateConfig({
      JENKINS_URL: "https://jenkins.example.com",
      JENKINS_USER: "alice",
      JENKINS_API_TOKEN: undefined,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain("jenkinsApiToken");
    }
  });
});

import { describe, expect, it } from "vitest";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";

describe("jobRestPath (REF-01)", () => {
  it("prepends /job/ and separates folder levels, replacing the four hand-built call sites", () => {
    expect(jobRestPath("my-job")).toBe("/job/my-job");
    expect(jobRestPath("team-a/team-b/my-job")).toBe("/job/team-a/job/team-b/job/my-job");
  });

  it("appends a ref as its own /job/ level, since a branch is a child job", () => {
    expect(jobRestPath("my-multibranch", "main")).toBe("/job/my-multibranch/job/main");
    expect(jobRestPath("team-a/svc", "PR-42")).toBe("/job/team-a/job/svc/job/PR-42");
  });

  it("encodes a slash inside a ref, so a caller never has to pre-encode a branch name", () => {
    expect(jobRestPath("my-multibranch", "feature/foo")).toBe(
      "/job/my-multibranch/job/feature%2Ffoo",
    );
  });

  it("does not double-encode an already-encoded folder segment", () => {
    // The v1 contract: a caller who passes a pre-encoded %2F must not get %252F.
    expect(jobRestPath("my-multibranch/feature%2Ffoo")).toBe(
      "/job/my-multibranch/job/feature%2Ffoo",
    );
  });

  it("treats an empty or absent ref as no ref at all", () => {
    expect(jobRestPath("my-job", "")).toBe("/job/my-job");
    expect(jobRestPath("my-job", undefined)).toBe("/job/my-job");
  });
});

describe("normalizeRef (REF-01)", () => {
  it("turns a bare integer into PR-<n> on a multibranch job", () => {
    expect(normalizeRef(42, true)).toBe("PR-42");
    expect(normalizeRef("42", true)).toBe("PR-42");
  });

  it("leaves a branch or tag name untouched", () => {
    expect(normalizeRef("main", true)).toBe("main");
    expect(normalizeRef("feature/foo", true)).toBe("feature/foo");
    expect(normalizeRef("v1.2.3", true)).toBe("v1.2.3");
    expect(normalizeRef("PR-42", true)).toBe("PR-42");
  });

  it("does NOT rewrite an integer on a non-multibranch job", () => {
    // Rewriting here would silently address a job that cannot exist; passing
    // it through lets the request fail honestly instead.
    expect(normalizeRef(42, false)).toBe("42");
  });

  it("treats undefined and blank as no ref", () => {
    expect(normalizeRef(undefined, true)).toBeUndefined();
    expect(normalizeRef("", true)).toBeUndefined();
    expect(normalizeRef("   ", true)).toBeUndefined();
  });
});

describe("resolveBuildSelector (REF-01)", () => {
  it("accepts a positive build number", () => {
    expect(resolveBuildSelector(12)).toBe("12");
    expect(resolveBuildSelector("12")).toBe("12");
  });

  it("treats -1 and an absent selector as the most recent build", () => {
    expect(resolveBuildSelector(-1)).toBe("lastBuild");
    expect(resolveBuildSelector("-1")).toBe("lastBuild");
    expect(resolveBuildSelector(undefined)).toBe("lastBuild");
  });

  it("passes a permalink alias straight through for Jenkins to resolve server-side", () => {
    expect(resolveBuildSelector("lastFailedBuild")).toBe("lastFailedBuild");
    expect(resolveBuildSelector("lastSuccessfulBuild")).toBe("lastSuccessfulBuild");
    expect(resolveBuildSelector("lastCompletedBuild")).toBe("lastCompletedBuild");
  });

  it("rejects a selector that is neither a build number nor a known alias", () => {
    // A typo must fail loudly rather than being sent to Jenkins as a path
    // segment that 404s with no explanation of what was wrong.
    for (const bad of ["lastBiuldBuild", "HEAD", "0", -5, 1.5]) {
      expect(() => resolveBuildSelector(bad)).toThrowError(/Invalid build selector/);
    }
  });

  it("reports an invalid selector as invalid_input, not as a transport failure", () => {
    expect(() => resolveBuildSelector("nope")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

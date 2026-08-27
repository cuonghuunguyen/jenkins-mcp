import { describe, expect, it } from "vitest";
import { encodeSegment, jobPath, parsePathString } from "../paths.js";

describe("parsePathString", () => {
  it("splits a job two folders deep into a segment array", () => {
    expect(parsePathString("team-a/sub-folder/my-job")).toEqual(["team-a", "sub-folder", "my-job"]);
  });

  it("preserves a %2F-encoded branch name as a single segment", () => {
    expect(parsePathString("team-a/my-multibranch/feature%2Ffoo")).toEqual([
      "team-a",
      "my-multibranch",
      "feature%2Ffoo",
    ]);
  });

  it("drops empty segments from leading, trailing, and repeated slashes", () => {
    expect(parsePathString("/team-a//my-job/")).toEqual(["team-a", "my-job"]);
    expect(parsePathString("")).toEqual([]);
    expect(parsePathString("///")).toEqual([]);
  });
});

describe("jobPath", () => {
  it("resolves a job two folders deep to a /job/-joined REST path", () => {
    const segments = parsePathString("team-a/sub-folder/my-job");
    expect(jobPath(segments)).toBe("team-a/job/sub-folder/job/my-job");
  });

  it("preserves a %2F branch segment without double-encoding it to %252F", () => {
    const segments = parsePathString("team-a/my-multibranch/feature%2Ffoo");
    expect(jobPath(segments)).toBe("team-a/job/my-multibranch/job/feature%2Ffoo");
    expect(jobPath(segments)).not.toContain("%252F");
  });

  it("round-trips a single top-level job with no /job/ separator needed", () => {
    expect(jobPath(parsePathString("my-job"))).toBe("my-job");
  });
});

describe("encodeSegment", () => {
  it("leaves an already-percent-encoded escape untouched", () => {
    expect(encodeSegment("feature%2Ffoo")).toBe("feature%2Ffoo");
  });

  it("escapes a stray literal % that is not part of a valid escape", () => {
    expect(encodeSegment("100%done")).toBe("100%25done");
  });
});

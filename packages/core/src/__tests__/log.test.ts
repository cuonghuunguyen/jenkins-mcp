/**
 * `getBuildLog` behaviour (READ-10) and the `save_to` containment rules
 * (READ-11).
 *
 * The client is faked, never global fetch. The `save_to` block writes for
 * real - into a `mkdtemp` directory it chdirs into - because the whole point
 * of that requirement is what the filesystem actually does with a symlink,
 * which a mocked `realpath` would not test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { formatLogResult, MAX_LOG_LINES } from "../format/log.js";
import {
  buildSegments,
  cleanLogLine,
  defaultSavePath,
  getBuildLog,
  saveRawLog,
  splitLogLines,
} from "../operations/log.js";
import { FREESTYLE_CLASS, WORKFLOW_CLASS } from "./fixtures.js";

const INDEX = {
  jobs: [
    { name: "svc", fullName: "team-a/svc", _class: FREESTYLE_CLASS, color: "blue" },
    { name: "mb", fullName: "mb", _class: WORKFLOW_CLASS, color: "blue" },
  ],
};

/** 500 lines, with two ERROR lines far apart so grep produces two groups. */
const CONSOLE = Array.from({ length: 500 }, (_, i) => {
  if (i === 9) return "ERROR early failure";
  if (i === 399) return "ERROR late failure";
  return `line ${i + 1}`;
}).join("\n");

interface Route {
  match: string;
  text?: string;
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

function makeClient(routes: Route[]) {
  const get = vi.fn(async (url: string) => {
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (route === undefined) return new Response("not found", { status: 404 });
    return new Response(route.text ?? JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  });
  const client = {
    get,
    post: vi.fn(),
    baseUrl: "https://jenkins.example.com",
  } as unknown as JenkinsClient;
  return { client, get };
}

/** The routes a plain finished freestyle build needs. */
function finishedRoutes(extra: Route[] = []): Route[] {
  return [
    { match: "tree=jobs[", body: INDEX },
    { match: "/api/json?tree=number", body: { number: 1042, building: false, result: "FAILURE" } },
    ...extra,
    { match: "/consoleText", text: CONSOLE },
  ];
}

function session(routes: Route[]) {
  const { client, get } = makeClient(routes);
  return { client, get, cache: new JenkinsCache() };
}

const BASE = { job: "team-a/svc", build: 1042, depth: 4 } as const;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe("mode=tail (READ-10)", () => {
  it("returns the last N lines numbered from their ORIGINAL position", async () => {
    const { client, cache } = session(finishedRoutes());

    const result = await getBuildLog(client, cache, { ...BASE, lines: 5 });

    expect(result.mode).toBe("tail");
    expect(result.totalLines).toBe(500);
    expect(result.shownLines).toBe(5);
    expect(result.segments[0]?.startLine).toBe(496);
    expect(result.segments[0]?.lines[0]).toBe("line 496");
  });

  it("defaults to the last 100 lines", async () => {
    const { client, cache } = session(finishedRoutes());

    const result = await getBuildLog(client, cache, BASE);

    expect(result.shownLines).toBe(100);
    expect(result.segments[0]?.startLine).toBe(401);
  });
});

describe("lines validation (READ-10)", () => {
  it("rejects lines below 1 in core, so the CLI and MCP cannot disagree", async () => {
    // `--lines 0` produced an empty window that rendered as "No log lines
    // found" - a bad argument reported as a genuinely empty log.
    for (const lines of [0, -5, 2.5]) {
      const { client, cache } = session(finishedRoutes());
      await expect(getBuildLog(client, cache, { ...BASE, lines })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });
});

describe("mode=grep (READ-10)", () => {
  it("reports the true match count and groups non-adjacent hits separately", async () => {
    const { client, cache } = session(finishedRoutes());

    const result = await getBuildLog(client, cache, { ...BASE, mode: "grep", pattern: "ERROR" });

    expect(result.matchCount).toBe(2);
    expect(result.segments).toHaveLength(2);
    // Context 2 either side, numbered from the original log.
    expect(result.segments[0]?.startLine).toBe(8);
    expect(result.segments[1]?.startLine).toBe(398);
  });

  it("returns no segments when nothing matches, rather than a silent empty window", async () => {
    const { client, cache } = session(finishedRoutes());

    const result = await getBuildLog(client, cache, { ...BASE, mode: "grep", pattern: "nope" });

    expect(result.matchCount).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it("rejects an invalid regex as invalid_input instead of crashing", async () => {
    const { client, cache } = session(finishedRoutes());

    await expect(
      getBuildLog(client, cache, { ...BASE, mode: "grep", pattern: "([" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("mode=range (READ-10)", () => {
  it("returns the 1-based inclusive range", async () => {
    const { client, cache } = session(finishedRoutes());

    const result = await getBuildLog(client, cache, { ...BASE, mode: "range", from: 10, to: 12 });

    expect(result.segments[0]?.startLine).toBe(10);
    expect(result.segments[0]?.lines).toEqual(["ERROR early failure", "line 11", "line 12"]);
  });

  it("rejects an inverted range", async () => {
    const { client, cache } = session(finishedRoutes());

    await expect(
      getBuildLog(client, cache, { ...BASE, mode: "range", from: 30, to: 10 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a range past the end, naming the real line count", async () => {
    const { client, cache } = session(finishedRoutes());

    await expect(
      getBuildLog(client, cache, { ...BASE, mode: "range", from: 900, to: 950 }),
    ).rejects.toThrowError(/500 lines/);
  });

  it("names the integer rule, not the ordering rule, for a fractional to", async () => {
    const { client, cache } = session(finishedRoutes());

    await expect(
      getBuildLog(client, cache, { ...BASE, mode: "range", from: 1, to: 2.5 }),
    ).rejects.toThrowError(/whole line number/);
  });

  it("rejects a start below line 1", async () => {
    const { client, cache } = session(finishedRoutes());

    await expect(
      getBuildLog(client, cache, { ...BASE, mode: "range", from: 0, to: 5 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("mode=step (READ-10)", () => {
  const describeBody = {
    stages: [
      { id: "17", name: "Build", status: "SUCCESS" },
      { id: "42", name: "Test", status: "FAILED" },
    ],
  };

  it("reads the stage's own log through wfapi when the plugin answers", async () => {
    const { client, cache } = session(
      finishedRoutes([
        { match: "/wfapi/describe", body: describeBody },
        { match: "/execution/node/42/wfapi/log", body: { text: "stage line 1\nstage line 2" } },
      ]),
    );

    const result = await getBuildLog(client, cache, { ...BASE, mode: "step", step: "Test" });

    expect(result.stepRoute).toBe("wfapi");
    expect(result.segments[0]?.lines).toEqual(["stage line 1", "stage line 2"]);
  });

  it("falls back to grepping the console when wfapi/describe 404s", async () => {
    const { client, cache } = session(
      finishedRoutes([{ match: "/wfapi/describe", text: "no such page", status: 404 }]),
    );

    const result = await getBuildLog(client, cache, { ...BASE, mode: "step", step: "line 250" });

    expect(result.stepRoute).toBe("console-grep");
    expect(result.matchCount).toBe(1);
    expect(result.segments[0]?.lines).toContain("line 250");
  });

  it("rejects mode=step without a step name", async () => {
    const { client, cache } = session(finishedRoutes());

    await expect(getBuildLog(client, cache, { ...BASE, mode: "step" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("mode=failed (READ-10)", () => {
  it("anchors the window on the stage wfapi reports as FAILED", async () => {
    const { client, cache } = session(
      finishedRoutes([
        {
          match: "/wfapi/describe",
          body: { stages: [{ id: "42", name: "line 250", status: "FAILED" }] },
        },
      ]),
    );

    const result = await getBuildLog(client, cache, { ...BASE, mode: "failed" });

    expect(result.failedStage).toBe("line 250");
    const segment = result.segments[0];
    expect(segment?.startLine).toBe(190);
    expect(segment?.lines).toContain("line 250");
  });

  it("caches the wfapi 404 so a freestyle build pays for it once", async () => {
    const { client, get, cache } = session(
      finishedRoutes([{ match: "/wfapi/describe", text: "gone", status: 404 }]),
    );

    await getBuildLog(client, cache, { ...BASE, mode: "failed" });
    await getBuildLog(client, cache, { ...BASE, mode: "failed" });

    expect(get.mock.calls.filter(([url]) => String(url).includes("/wfapi/describe"))).toHaveLength(
      1,
    );
  });

  it("falls back to the last error marker when wfapi is unavailable", async () => {
    const { client, cache } = session(
      finishedRoutes([{ match: "/wfapi/describe", text: "gone", status: 404 }]),
    );

    const result = await getBuildLog(client, cache, { ...BASE, mode: "failed" });

    expect(result.failedStage).toBeUndefined();
    expect(result.segments[0]?.lines).toContain("ERROR late failure");
  });
});

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

describe("clean (READ-10)", () => {
  const noisy = "[2026-08-27T10:00:00.000Z] \u001B[31mFAILED\u001B[0m here";

  it("strips ANSI escapes and the Jenkins timestamp prefix by default", async () => {
    const { client, cache } = session([
      { match: "tree=jobs[", body: INDEX },
      { match: "/api/json?tree=number", body: { number: 7, building: false, result: "FAILURE" } },
      { match: "/consoleText", text: noisy },
    ]);

    const result = await getBuildLog(client, cache, { job: "team-a/svc", build: 7, depth: 4 });

    expect(result.segments[0]?.lines[0]).toBe("FAILED here");
  });

  it("keeps the raw text when clean is false", async () => {
    const { client, cache } = session([
      { match: "tree=jobs[", body: INDEX },
      { match: "/api/json?tree=number", body: { number: 7, building: false, result: "FAILURE" } },
      { match: "/consoleText", text: noisy },
    ]);

    const result = await getBuildLog(client, cache, {
      job: "team-a/svc",
      build: 7,
      depth: 4,
      clean: false,
    });

    expect(result.segments[0]?.lines[0]).toBe(noisy);
  });

  it("leaves a plain line untouched", () => {
    expect(cleanLogLine("+ npm test")).toBe("+ npm test");
  });
});

// ---------------------------------------------------------------------------
// Progressive cursor
// ---------------------------------------------------------------------------

describe("progressive cursor (READ-10)", () => {
  const routes: Route[] = [
    { match: "tree=jobs[", body: INDEX },
    { match: "/api/json?tree=number", body: { number: 9, building: true, result: null } },
    {
      match: "/logText/progressiveText",
      text: "new line a\nnew line b",
      headers: { "X-Text-Size": "4096", "X-More-Data": "true" },
    },
  ];

  it("returns nextCursor from X-Text-Size and hasMore from X-More-Data", async () => {
    const { client, cache } = session(routes);

    const result = await getBuildLog(client, cache, {
      job: "team-a/svc",
      build: 9,
      depth: 4,
      cursor: 1024,
    });

    expect(result.nextCursor).toBe(4096);
    expect(result.hasMore).toBe(true);
    expect(result.chunkRelative).toBe(true);
    expect(result.segments[0]?.lines).toEqual(["new line a", "new line b"]);
  });

  it("leaves nextCursor undefined when X-Text-Size is missing or unparseable", async () => {
    // Echoing the cursor back made the formatter tell the agent to poll the
    // identical byte offset forever.
    for (const headers of [{}, { "X-Text-Size": "not-a-number" }]) {
      const { client, cache } = session([
        { match: "tree=jobs[", body: INDEX },
        { match: "/api/json?tree=number", body: { number: 9, building: true, result: null } },
        { match: "/logText/progressiveText", text: "a\nb", headers },
      ]);

      const result = await getBuildLog(client, cache, {
        job: "team-a/svc",
        build: 9,
        depth: 4,
        cursor: 100,
      });

      expect(result.nextCursor).toBeUndefined();
      expect(formatLogResult(result)).not.toContain("cursor=100");
    }
  });

  it("rejects cursor with a non-tail mode instead of returning the unfiltered chunk", async () => {
    // The cursor branch returned before the mode switch, so the header
    // advertised mode=grep and a fabricated match count over raw chunk lines.
    const { client, cache } = session(routes);

    await expect(
      getBuildLog(client, cache, {
        job: "team-a/svc",
        build: 9,
        depth: 4,
        cursor: 100,
        mode: "grep",
        pattern: "ERROR",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects cursor with save_to, which overwrote the full log with one chunk", async () => {
    const { client, cache } = session(routes);

    await expect(
      getBuildLog(client, cache, {
        job: "team-a/svc",
        build: 9,
        depth: 4,
        cursor: 100,
        saveTo: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("hands a running build's first read the byte offset to poll from", async () => {
    // Without this there is no documented route into progressive polling.
    const { client, cache } = session([
      { match: "tree=jobs[", body: INDEX },
      { match: "/api/json?tree=number", body: { number: 9, building: true, result: null } },
      { match: "/consoleText", text: "a\nb\n" },
    ]);

    const result = await getBuildLog(client, cache, { job: "team-a/svc", build: 9, depth: 4 });

    expect(result.nextCursor).toBe(4);
    expect(formatLogResult(result)).toContain("{log} with cursor=4 for the next chunk");
  });

  it("never caches a cursor fetch - the whole point is what arrived since", async () => {
    const { client, get, cache } = session(routes);
    const args = { job: "team-a/svc", build: 9, depth: 4, cursor: 1024 };

    await getBuildLog(client, cache, args);
    await getBuildLog(client, cache, args);

    const progressive = get.mock.calls.filter(([url]) => url.includes("progressiveText"));
    expect(progressive).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Cache tiers (AGNT-01)
// ---------------------------------------------------------------------------

describe("cache tiers (AGNT-01)", () => {
  it("caches a finished numbered build's log permanently", async () => {
    vi.useFakeTimers();
    const { client, cache } = session(finishedRoutes());

    await getBuildLog(client, cache, BASE);
    const afterFirst = cache.loadCount();
    vi.advanceTimersByTime(120_000);
    await getBuildLog(client, cache, BASE);

    // Only the 60s job index expires; the build summary and the console text
    // can never change, so neither is refetched.
    expect(cache.loadCount()).toBe(afterFirst + 1);
  });

  it("keeps a running build's log volatile", async () => {
    vi.useFakeTimers();
    const { client, cache } = session([
      { match: "tree=jobs[", body: INDEX },
      { match: "/api/json?tree=number", body: { number: 9, building: true, result: null } },
      { match: "/consoleText", text: CONSOLE },
    ]);
    const args = { job: "team-a/svc", build: 9, depth: 4 };

    await getBuildLog(client, cache, args);
    const afterFirst = cache.loadCount();
    vi.advanceTimersByTime(30_000);
    await getBuildLog(client, cache, args);

    // Build summary + console text both re-read; the index has not expired.
    expect(cache.loadCount()).toBe(afterFirst + 2);
  });
});

// ---------------------------------------------------------------------------
// READ-11: save_to
// ---------------------------------------------------------------------------

describe("save_to containment (READ-11)", () => {
  function inTempCwd<T>(body: (dir: string) => T): T {
    const previous = process.cwd();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-log-")));
    try {
      process.chdir(dir);
      return body(dir);
    } finally {
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("builds the documented default path with the job path as real directories", () => {
    // READ-11 specifies `.jenkins-mcp/cli/<job>/<ref>/<build>.log`. The job
    // path is nested directories, not a flattened `team-a-svc` segment.
    expect(defaultSavePath("team-a/svc", "feature/foo", "1042")).toBe(
      ".jenkins-mcp/cli/team-a/svc/feature/foo/1042.log",
    );
  });

  it("decodes a %2F-encoded ref exactly once, so both spellings land in one place", () => {
    expect(defaultSavePath("svc", "feature%2Ffoo", "3")).toBe(
      defaultSavePath("svc", "feature/foo", "3"),
    );
  });

  it("REJECTS a ref that decodes to a traversal rather than sanitizing it", () => {
    // Silently rewriting `..` into a lookalike directory is how a containment
    // check gets bypassed without anyone noticing.
    expect(() => defaultSavePath("svc", "%2E%2E%2F%2E%2E", "3")).toThrowError(/traverses/);
    expect(() => defaultSavePath("svc", "../../etc", "3")).toThrowError(/traverses/);
    expect(() => defaultSavePath("../evil", undefined, "3")).toThrowError(/traverses/);
  });

  it("rejects an address component that decodes to an absolute path", () => {
    expect(() => defaultSavePath("svc", "%2Fetc%2Fpasswd", "3")).toThrowError(/absolute/);
  });

  it("rejects an absolute path", () => {
    inTempCwd(() => {
      expect(() => saveRawLog("/tmp/evil.log", "fallback.log", "x")).toThrowError(/absolute/);
    });
  });

  it("rejects a .. traversal", () => {
    inTempCwd(() => {
      expect(() => saveRawLog("../escape.log", "fallback.log", "x")).toThrowError(/traverse/);
    });
  });

  it("rejects a symlinked directory whose real target is outside cwd", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-outside-")));
    try {
      inTempCwd((dir) => {
        // A resolve-only check passes here: `<cwd>/link/x.log` is textually
        // inside cwd. Only realpath on the nearest existing ancestor catches it.
        fs.symlinkSync(outside, path.join(dir, "link"), "dir");
        expect(() => saveRawLog("link/x.log", "fallback.log", "x")).toThrowError(/symlink/);
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing DANGLING symlink, which existsSync read as absent", () => {
    // The reviewer's own reproduction. `fs.existsSync` FOLLOWS symlinks, so a
    // link to a not-yet-created file outside cwd read as "does not exist", the
    // walk-up skipped past it, and writeFileSync then created the file at the
    // link's target. Nothing here is mocked: a real dangling link, a real write
    // attempt, and the outside path asserted afterwards.
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-outside-")));
    const victim = path.join(outside, "pwned.log");
    try {
      inTempCwd((dir) => {
        fs.symlinkSync(victim, path.join(dir, "dangling.log"));

        expect(() => saveRawLog("dangling.log", "fallback.log", "PWNED")).toThrowError(/symlink/);
      });
      expect(fs.existsSync(victim)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a hardlink to a file outside cwd without truncating it first", () => {
    // A hardlink is invisible to every path check - realpath returns the in-cwd
    // path - so only the inode's link count catches it. Asserted on the victim's
    // CONTENT, because an O_TRUNC before the check would already have emptied it.
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-outside-")));
    const victim = path.join(outside, "victim.log");
    try {
      fs.writeFileSync(victim, "ORIGINAL", "utf8");
      inTempCwd((dir) => {
        fs.linkSync(victim, path.join(dir, "hard.log"));

        expect(() => saveRawLog("hard.log", "fallback.log", "CLOBBERED")).toThrowError(/hard link/);
      });
      expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("overwrites an ordinary existing file rather than appending to it", () => {
    inTempCwd(() => {
      saveRawLog("out.log", "fallback.log", "first-and-longer");
      const summary = saveRawLog("out.log", "fallback.log", "second");

      expect(fs.readFileSync("out.log", "utf8")).toBe("second");
      expect(summary.bytes).toBe(6);
    });
  });

  it("writes the file and returns a summary", () => {
    inTempCwd(() => {
      const summary = saveRawLog("out/build.log", "fallback.log", "a\nb\n");

      expect(summary).toEqual({ savedTo: path.join("out", "build.log"), bytes: 4, lines: 2 });
      expect(fs.readFileSync("out/build.log", "utf8")).toBe("a\nb\n");
    });
  });

  it("uses the fallback path when save_to is empty", () => {
    inTempCwd(() => {
      const summary = saveRawLog("", ".jenkins-mcp/cli/svc/7.log", "a");
      expect(summary.savedTo).toBe(path.join(".jenkins-mcp", "cli", "svc", "7.log"));
    });
  });
});

describe("save_to through the operation (READ-11)", () => {
  const noisy = "[2026-08-27T10:00:00.000Z] \u001B[31mFAILED\u001B[0m here";

  it("returns a summary instead of the body, and writes the RAW log even when clean is on", async () => {
    const previous = process.cwd();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-log-op-")));
    try {
      process.chdir(dir);
      const { client, cache } = session([
        { match: "tree=jobs[", body: INDEX },
        { match: "/api/json?tree=number", body: { number: 7, building: false, result: "FAILURE" } },
        { match: "/consoleText", text: noisy },
      ]);

      const result = await getBuildLog(client, cache, {
        job: "team-a/svc",
        build: 7,
        depth: 4,
        clean: true,
        saveTo: "",
      });

      expect(result.segments).toEqual([]);
      expect(result.saved?.savedTo).toBe(
        path.join(".jenkins-mcp", "cli", "team-a", "svc", "7.log"),
      );
      expect(fs.readFileSync(result.saved?.savedTo ?? "", "utf8")).toBe(noisy);
    } finally {
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("drops the single trailing newline so line counts are not off by one", () => {
    expect(splitLogLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLogLines("")).toEqual([]);
  });

  it("merges touching context windows into one segment", () => {
    const lines = ["a", "b", "c", "d", "e"];
    expect(buildSegments(lines, [1, 3], 1)).toEqual([{ startLine: 1, lines }]);
  });
});

// ---------------------------------------------------------------------------
// Formatter (AGNT-03/AGNT-04)
// ---------------------------------------------------------------------------

describe("formatLogResult (AGNT-03/AGNT-04)", () => {
  it("states the mode and the slice, and numbers lines from the original log", async () => {
    const { client, cache } = session(finishedRoutes());

    const text = formatLogResult(await getBuildLog(client, cache, { ...BASE, lines: 3 }));

    expect(text).toContain("team-a/svc #1042 log  mode=tail  lines 498-500 of 500");
    expect(text).toContain("498  line 498");
    expect(text).toContain("next: {log}");
  });

  it("names the exact call that returns the rest when the body is truncated", async () => {
    // The whole string, numbers included: asserting only the `mode=range`
    // prefix is what let `from=1 to=200` - the 200 lines just shown - ship.
    const { client, cache } = session(finishedRoutes());

    const text = formatLogResult(
      await getBuildLog(client, cache, { ...BASE, mode: "range", from: 1, to: 500 }),
    );

    expect(text).toContain(
      `[showing ${MAX_LOG_LINES} of 500 lines — next: {log} with mode=range from=201 to=500]`,
    );
    // The header describes the body that came back, not the window requested.
    expect(text).toContain("mode=range  lines 1-200 of 500");
  });

  it("keeps the END of the window for mode=tail, which is what tail means", async () => {
    // `lines: 400` used to render 101-300 and drop 301-500: the caller asked
    // for the end of the log and got the opposite end of it.
    const { client, cache } = session(finishedRoutes());

    const text = formatLogResult(await getBuildLog(client, cache, { ...BASE, lines: 400 }));

    expect(text).toContain("mode=tail  lines 301-500 of 500");
    expect(text).toContain("500  line 500");
    expect(text).not.toContain("101  line 101");
    // The dropped lines are the OLDER ones, so that is what the hint names.
    expect(text).toContain(
      `[showing ${MAX_LOG_LINES} of 400 lines — next: {log} with mode=range from=101 to=300]`,
    );
  });

  it("keeps the end of a mode=failed window too", async () => {
    const { client, cache } = session(
      finishedRoutes([{ match: "/wfapi/describe", text: "gone", status: 404 }]),
    );

    const text = formatLogResult(await getBuildLog(client, cache, { ...BASE, mode: "failed" }));

    expect(text).toContain("ERROR late failure");
  });

  it("counts real log lines, not the ... group separators, when truncating a grep", async () => {
    const console100 = Array.from({ length: 600 }, (_, i) =>
      i % 6 === 0 ? `ERROR ${i}` : `line ${i + 1}`,
    ).join("\n");
    const { client, cache } = session([
      { match: "tree=jobs[", body: INDEX },
      { match: "/api/json?tree=number", body: { number: 8, building: false, result: "FAILURE" } },
      { match: "/consoleText", text: console100 },
    ]);

    const result = await getBuildLog(client, cache, {
      job: "team-a/svc",
      build: 8,
      depth: 4,
      mode: "grep",
      pattern: "ERROR",
      context: 0,
    });
    const text = formatLogResult(result);

    // 100 matches, context 0 -> 100 separate one-line groups, well under the
    // cap in real lines. The old join-then-count treated the 99 "..." lines as
    // log lines and reported a truncation that never happened.
    expect(result.shownLines).toBe(100);
    expect(text).toContain("100 match(es), showing 100 of 600 lines");
    expect(text).not.toContain("[showing");
  });

  it("only suggests context=0 for a grep that is actually using context", async () => {
    // With context already 0 the old hint repeated the call just made verbatim,
    // so an agent following it looped.
    const wide = Array.from({ length: 900 }, (_, i) =>
      i % 3 === 0 ? `ERROR ${i}` : `line ${i + 1}`,
    ).join("\n");
    const wideRoutes: Route[] = [
      { match: "tree=jobs[", body: INDEX },
      { match: "/api/json?tree=number", body: { number: 8, building: false, result: "FAILURE" } },
      { match: "/consoleText", text: wide },
    ];
    // `maxMatches` is raised past the 300 hits so the SCAN is not what limits
    // the output here - the format-layer line cap is, which is what this test
    // is about.
    const args = {
      job: "team-a/svc",
      build: 8,
      depth: 4,
      mode: "grep" as const,
      pattern: "ERROR",
      maxMatches: 400,
    };

    const wide2 = session(wideRoutes);
    const withContext = formatLogResult(
      await getBuildLog(wide2.client, wide2.cache, { ...args, context: 2 }),
    );
    expect(withContext).toContain("next: {log} with mode=grep pattern=ERROR context=0");

    const zero = session(wideRoutes);
    const noContext = formatLogResult(
      await getBuildLog(zero.client, zero.cache, { ...args, context: 0 }),
    );
    expect(noContext).not.toContain("context=0]");
    expect(noContext).toMatch(/next: \{log\} with mode=range from=\d+ to=\d+]/);
  });

  it("labels the wfapi stage numbering space and never offers mode=range there", async () => {
    // The stage log's line 1 is not the console's line 1; a mode=range
    // follow-up would silently return different text.
    const { client, cache } = session(
      finishedRoutes([
        { match: "/wfapi/describe", body: { stages: [{ id: "42", name: "Test" }] } },
        { match: "/execution/node/42/wfapi/log", body: { text: "stage a\nstage b" } },
      ]),
    );

    const text = formatLogResult(
      await getBuildLog(client, cache, { ...BASE, mode: "step", step: "Test" }),
    );

    expect(text).toContain("stage lines 1-2 of 2");
    expect(text).not.toContain("mode=range");
  });

  it("separates non-adjacent grep groups with ...", async () => {
    const { client, cache } = session(finishedRoutes());

    const text = formatLogResult(
      await getBuildLog(client, cache, { ...BASE, mode: "grep", pattern: "ERROR" }),
    );

    expect(text).toContain("2 match(es)");
    expect(text).toContain("\n...\n");
  });

  it("renders an explicit empty state for a grep that matched nothing", async () => {
    const { client, cache } = session(finishedRoutes());

    const text = formatLogResult(
      await getBuildLog(client, cache, { ...BASE, mode: "grep", pattern: "nope" }),
    );

    expect(text).toContain("No log lines matched nope");
  });

  it("renders only the summary for a saved log, never the body", async () => {
    const previous = process.cwd();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-log-fmt-")));
    try {
      process.chdir(dir);
      const { client, cache } = session(finishedRoutes());

      const text = formatLogResult(
        await getBuildLog(client, cache, { ...BASE, saveTo: "out/x.log" }),
      );

      expect(text).toContain("saved: out/x.log");
      expect(text).not.toContain("line 500");
    } finally {
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at the next cursor while a build is still writing", () => {
    const text = formatLogResult({
      job: "team-a/svc",
      selector: "lastBuild",
      buildNumber: 9,
      building: true,
      mode: "tail",
      totalLines: 2,
      segments: [{ startLine: 1, lines: ["a", "b"] }],
      shownLines: 2,
      chunkRelative: true,
      nextCursor: 4096,
      hasMore: true,
    });

    expect(text).toContain("[more output available — next: {log} with cursor=4096]");
  });
});

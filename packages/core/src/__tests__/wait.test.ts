/**
 * `waitForBuild` (CTRL-06, Phase 7 criterion 1).
 *
 * The properties worth locking down are the loop's, not the payload's: it
 * always terminates, it never caches a poll, it backs off, a timeout is a
 * RESULT rather than a throw, and no caller-supplied value can remove its
 * only exit condition.
 */

import { describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { formatWaitResult } from "../format/wait.js";
import { transitionsSince, waitForBuild } from "../operations/wait.js";
import { NESTED_INDEX } from "./fixtures.js";

interface Scripted {
  /** wfapi/describe bodies, consumed in order (last one repeats). */
  wfapi?: Array<Record<string, unknown> | number>;
  /** api/json bodies, consumed in order (last one repeats). */
  api?: Array<Record<string, unknown> | number>;
  /** progressiveText body plus headers. */
  progressive?: { text: string; size?: number; more?: boolean };
}

/**
 * A client whose wfapi and api/json answers come from scripted sequences. A
 * number in a sequence means "answer with this HTTP status and an empty body".
 * `wfapi: undefined` answers 404, which is the freestyle / no-plugin case.
 */
function clientOf(script: Scripted) {
  const paths: string[] = [];
  let wfapiCall = 0;
  let apiCall = 0;

  const answer = (seq: Array<Record<string, unknown> | number>, index: number) => {
    const entry = seq[Math.min(index, seq.length - 1)];
    if (typeof entry === "number") return new Response(null, { status: entry });
    return new Response(JSON.stringify(entry), { status: 200 });
  };

  const get = vi.fn(async (path: string) => {
    paths.push(path);
    if (path.includes("/api/json?tree=jobs[")) {
      return new Response(JSON.stringify(NESTED_INDEX), { status: 200 });
    }
    if (path.includes("/wfapi/describe")) {
      if (script.wfapi === undefined) return new Response(null, { status: 404 });
      return answer(script.wfapi, wfapiCall++);
    }
    if (path.includes("/logText/progressiveText")) {
      const p = script.progressive ?? { text: "" };
      return new Response(p.text, {
        status: 200,
        headers: {
          "X-Text-Size": String(p.size ?? p.text.length),
          "X-More-Data": p.more === true ? "true" : "false",
        },
      });
    }
    return answer(script.api ?? [{}], apiCall++);
  });

  return {
    client: {
      get,
      post: vi.fn(),
      baseUrl: "https://jenkins.example.com",
    } as unknown as JenkinsClient,
    get,
    paths,
  };
}

const FINISHED = {
  number: 42,
  result: "SUCCESS",
  building: false,
  duration: 200_000,
  timestamp: 1_700_000_000_000,
  url: "https://jenkins.example.com/job/svc/42/",
};
const RUNNING = { number: 42, result: null, building: true, url: FINISHED.url };

/** A wfapi/describe body. */
function describe_(status: string, stages: Array<[string, string, string]> = []) {
  return {
    id: "42",
    status,
    durationMillis: 200_000,
    startTimeMillis: 1_700_000_000_000,
    stages: stages.map(([id, name, s]) => ({ id, name, status: s, durationMillis: 1_000 })),
  };
}

describe("waitForBuild (CTRL-06)", () => {
  it("returns immediately for an already-finished freestyle build", async () => {
    const { client, get } = clientOf({ api: [FINISHED] });

    const result = await waitForBuild(client, new JenkinsCache(), { job: "svc", build: 42 });

    // wfapi 404 (not counted as a poll), then one api/json read.
    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ finished: true, polls: 1, result: "SUCCESS", building: false });
    expect(result.stopped).toBeUndefined();
    expect(result.wfapiUnavailable).toBe(true);
  });

  it("polls until the build stops building", async () => {
    const { client } = clientOf({ api: [RUNNING, RUNNING, FINISHED] });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({ finished: true, polls: 3, result: "SUCCESS" });
  });

  it("never reads the poll from the cache, and drops THIS build's cache once finished", async () => {
    const { client } = clientOf({ api: [FINISHED] });
    const cache = new JenkinsCache();
    // A stale "still running" entry, exactly what a cached poll would replay.
    await cache.fetch(
      "job:svc ref: build:42 summary",
      async () => ({ building: true }),
      "volatile",
    );
    // Another ref's PERMANENT entry, which a read-only wait has no business
    // discarding (it did, via `invalidateJob`'s `job:<job> ` prefix).
    await cache.fetch("job:svc ref:main build:9 summary", async () => ({}), "permanent");

    const result = await waitForBuild(client, cache, { job: "svc", build: 42 });

    expect(result.finished).toBe(true);
    expect(cache.size()).toBe(1);
    // Two loads: the two primed entries. The poll itself never touched the cache.
    expect(cache.loadCount()).toBe(2);
  });

  it("returns finished: false with the last-known state when the timeout elapses", async () => {
    const { client } = clientOf({ api: [RUNNING] });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      timeoutMs: 0,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({
      finished: false,
      stopped: "timeout",
      building: true,
      number: 42,
    });
  });

  it("honours an abort signal instead of running to the timeout", async () => {
    const { client, get } = clientOf({ api: [RUNNING] });
    const controller = new AbortController();
    controller.abort();

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      timeoutMs: 600_000,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ finished: false, stopped: "aborted" });
    // An ALREADY-aborted signal must not cost a round trip at all: the check
    // used to run only AFTER the poll, so a cancelled wait still paid for one
    // full request (up to the client's 60s timeout).
    expect(get).toHaveBeenCalledTimes(0);
  });

  it("backs off exponentially between polls, capped at 15s", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientOf({ api: [RUNNING] });
      const timer = vi.spyOn(globalThis, "setTimeout");

      const pending = waitForBuild(client, new JenkinsCache(), {
        job: "svc",
        build: 42,
        timeoutMs: 60_000,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.finished).toBe(false);
      const delays = timer.mock.calls.map((call) => call[1] ?? 0);
      expect(delays.slice(0, 3)).toEqual([2000, 3000, 4500]);
      expect(Math.max(...delays)).toBe(15_000);
    } finally {
      // Order matters: `restoreAllMocks` puts back whatever `setTimeout` was
      // when the spy was created - which is the FAKE one. Restoring the spy
      // first, then the real timers, leaves the global genuinely real.
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("throws a normalized error when the FIRST poll fails - there is nothing to report yet", async () => {
    const { client } = clientOf({ api: [403] });

    await expect(
      waitForBuild(client, new JenkinsCache(), { job: "svc", build: 42 }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("treats a bare integer ref as a PR only when the job is multibranch", async () => {
    const { client, paths } = clientOf({ api: [FINISHED] });

    await waitForBuild(client, new JenkinsCache(), {
      job: "my-multibranch",
      ref: "42",
      build: 7,
      depth: 6,
    });

    expect(paths.at(-1)).toContain("/job/my-multibranch/job/PR-42/7/api/json");
  });

  it("uses the ref verbatim when no depth is given (the trigger-chained case)", async () => {
    const { client, paths } = clientOf({ api: [FINISHED] });

    await waitForBuild(client, new JenkinsCache(), { job: "svc", ref: "main", build: 7 });

    // No index request: the caller already resolved the ref.
    expect(paths.some((p) => p.includes("tree=jobs["))).toBe(false);
    expect(paths.at(-1)).toContain("/job/svc/job/main/7/api/json");
  });
});

describe("waitForBuild bound (review HIGH: NaN removes the loop's only exit)", () => {
  it("falls back to the default bound for a non-numeric timeout instead of never returning", async () => {
    // `jenkins build wait 7 --timeout abc` -> yargs coerces to NaN -> every
    // `Date.now() - start >= NaN` is false, so the loop had no elapsed-time
    // exit at all and polled a hung build until the process was killed.
    vi.useFakeTimers();
    try {
      const { client } = clientOf({ api: [RUNNING] });

      const pending = waitForBuild(client, new JenkinsCache(), {
        job: "svc",
        build: 42,
        timeoutMs: Number.NaN,
      });
      // Past the 120s default. On the old code this loop had no elapsed-time
      // exit at all and `advanceTimersByTimeAsync` would never let it settle.
      await vi.advanceTimersByTimeAsync(200_000);
      const result = await pending;

      expect(result.stopped).toBe("timeout");
      expect(result.finished).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Infinity as a genuinely unbounded wait, ended by the signal", async () => {
    const controller = new AbortController();
    const { client } = clientOf({ api: [RUNNING] });
    setTimeout(() => controller.abort(), 20);

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      timeoutMs: Number.POSITIVE_INFINITY,
      pollIntervalMs: 1,
      signal: controller.signal,
    });

    expect(result.stopped).toBe("aborted");
  }, 10_000);
});

describe("waitForBuild transient failures (review MEDIUM)", () => {
  it("tolerates a blip after a successful poll instead of discarding the whole wait", async () => {
    // 1 good poll, then one 503 from a restarting controller, then done. The
    // old code threw on the 503 and the caller learned only "HTTP 503".
    const { client } = clientOf({ api: [RUNNING, 503, FINISHED] });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({ finished: true, result: "SUCCESS", transientErrors: 1 });
  });

  it("gives up as a RESULT, not a throw, once the blips stop being blips", async () => {
    const { client } = clientOf({ api: [RUNNING, 503, 503, 503, 503, 503] });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({ finished: false, stopped: "error", number: 42 });
    expect(result.lastErrorCode).toBe("http_error");
  });
});

describe("waitForBuild stage transitions and input steps (Phase 7 criterion 1)", () => {
  it("polls wfapi/describe and returns the stage table", async () => {
    const { client, paths } = clientOf({
      wfapi: [
        describe_("SUCCESS", [
          ["6", "Build", "SUCCESS"],
          ["12", "Test", "SUCCESS"],
        ]),
      ],
      api: [FINISHED],
    });

    const result = await waitForBuild(client, new JenkinsCache(), { job: "svc", build: 42 });

    expect(paths.some((p) => p.includes("/wfapi/describe"))).toBe(true);
    expect(result.finished).toBe(true);
    expect(result.stages?.map((s) => s.name)).toEqual(["Build", "Test"]);
    expect(result.nextCursor).toBe("12");
    // api/json still fills in the fields only it carries.
    expect(result.url).toBe(FINISHED.url);
  });

  it("returns only the transitions since the stage cursor", async () => {
    const { client } = clientOf({
      wfapi: [
        describe_("SUCCESS", [
          ["6", "Build", "SUCCESS"],
          ["12", "Test", "SUCCESS"],
          ["18", "Deploy", "SUCCESS"],
        ]),
      ],
      api: [FINISHED],
    });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      sinceCursor: "12",
    });

    // From the cursor stage INCLUSIVE: its own status may have moved on since
    // the caller was told about it, and nothing records what it was then.
    expect(result.stages?.map((s) => s.name)).toEqual(["Test", "Deploy"]);
  });

  it("ENDS the wait when a stage is waiting on an input step", async () => {
    // A pipeline paused on `input` never finishes on its own, so a wait that
    // cannot see it burns the whole timeout and then says "still running".
    const { client } = clientOf({
      wfapi: [
        describe_("PAUSED_PENDING_INPUT", [
          ["6", "Build", "SUCCESS"],
          ["12", "Approve deploy", "PAUSED_PENDING_INPUT"],
        ]),
      ],
      api: [RUNNING],
    });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      timeoutMs: 600_000,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({
      finished: false,
      stopped: "input",
      inputStage: "Approve deploy",
    });
    expect(formatWaitResult(result)).toContain("PAUSED — waiting for input at stage");
  }, 10_000);

  it("falls back to api/json when wfapi 404s, and says so", async () => {
    const { client, paths } = clientOf({ api: [FINISHED] });

    const result = await waitForBuild(client, new JenkinsCache(), { job: "svc", build: 42 });

    expect(paths.filter((p) => p.includes("/wfapi/describe")).length).toBe(1);
    expect(result.wfapiUnavailable).toBe(true);
    expect(result.stages).toBeUndefined();
    expect(result.finished).toBe(true);
  });

  it("returns the new log lines since the byte cursor, and the next one", async () => {
    const { client } = clientOf({
      api: [FINISHED],
      progressive: { text: "line A\nline B\n", size: 4096 },
    });

    const result = await waitForBuild(client, new JenkinsCache(), {
      job: "svc",
      build: 42,
      logCursor: 2048,
    });

    expect(result.newLines).toEqual(["line A", "line B"]);
    expect(result.nextLogCursor).toBe(4096);
    expect(formatWaitResult(result)).toContain("log_cursor: 4096");
  });

  it("does not fetch the log at all when no cursor was given", async () => {
    const { client, paths } = clientOf({ api: [FINISHED] });

    const result = await waitForBuild(client, new JenkinsCache(), { job: "svc", build: 42 });

    expect(paths.some((p) => p.includes("progressiveText"))).toBe(false);
    expect(result.newLines).toBeUndefined();
  });
});

describe("transitionsSince", () => {
  const stages = [
    { id: "6", name: "Build", status: "SUCCESS" },
    { id: "12", name: "Test", status: "SUCCESS" },
  ];

  it("returns everything when there is no cursor", () => {
    expect(transitionsSince(stages, undefined)).toEqual(stages);
  });

  it("returns everything for a cursor from a different build, rather than nothing", () => {
    // Silently returning [] would read as "no progress", which is a worse
    // answer than repeating the list.
    expect(transitionsSince(stages, "999")).toEqual(stages);
  });
});

describe("formatWaitResult (CTRL-06, AGNT-03/AGNT-04)", () => {
  const base = {
    job: "team-a/svc",
    ref: "main",
    selector: "42",
    number: 42,
    waitedMs: 74_000,
    polls: 6,
    url: FINISHED.url,
  };

  it("renders a finished failure with diagnosis hints", () => {
    const text = formatWaitResult({
      ...base,
      finished: true,
      result: "FAILURE",
      building: false,
      durationMs: 200_000,
    });

    expect(text).toContain("status: FAILURE");
    expect(text).toContain("waited: 1m14s (6 polls)");
    expect(text).toContain("next: {diagnose}");
  });

  it("renders a timed-out wait as still building, pointing back at the same call", () => {
    const text = formatWaitResult({
      ...base,
      finished: false,
      stopped: "timeout",
      result: null,
      building: true,
    });

    expect(text).toContain("still BUILDING");
    expect(text).toContain("wait timed out");
    expect(text).toContain("next: {wait}");
    expect(text).not.toContain("error:");
  });

  it("renders stage transitions as a compact table and states the cursors", () => {
    const text = formatWaitResult({
      ...base,
      finished: true,
      result: "SUCCESS",
      building: false,
      durationMs: 200_000,
      stages: [
        { id: "6", name: "Build", status: "SUCCESS", durationMs: 61_000 },
        { id: "12", name: "Test", status: "FAILED", durationMs: 2_000 },
      ],
      nextCursor: "12",
      newLines: ["a", "b"],
      nextLogCursor: 900,
    });

    expect(text).toContain("stages (2)");
    expect(text).toContain("Build");
    expect(text).toContain("since_cursor: 12");
    expect(text).toContain("log_cursor: 900");
    expect(text).toContain("new log lines");
  });
});

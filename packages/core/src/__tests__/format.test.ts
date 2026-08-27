import { describe, expect, it } from "vitest";
import { applyCommandRefs, type CommandVocabulary, JenkinsError } from "../errors.js";
import {
  capBytes,
  emptyState,
  formatAge,
  formatDuration,
  formatErrorLine,
  listHeader,
  numberLines,
  table,
  truncateLines,
  withNext,
} from "../format/common.js";

describe("table (AGNT-03)", () => {
  it("aligns columns and leaves no trailing whitespace on the last column", () => {
    const rendered = table(
      ["fullName", "type", "status"],
      [
        ["team-a/svc", "pipeline", "success"],
        ["b", "freestyle", "failed"],
      ],
    );

    expect(rendered).toBe(
      [
        "fullName    type       status",
        "team-a/svc  pipeline   success",
        "b           freestyle  failed",
      ].join("\n"),
    );
    for (const line of rendered.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("renders an empty cell as - so a row never collapses into ambiguity", () => {
    expect(table(["a", "b"], [["x", ""]])).toContain("x  -");
  });
});

describe("aggregate counts (AGNT-03)", () => {
  it("states the total when the list is complete", () => {
    expect(listHeader("jobs", 3, 3)).toBe("jobs (3)");
  });

  it("states both counts when the list is truncated, so it cannot read as complete", () => {
    expect(listHeader("jobs", 20, 137)).toBe("jobs (showing 20 of 137)");
  });
});

describe("empty states (AGNT-03)", () => {
  it("names the query, so no-match is distinguishable from a silent failure", () => {
    expect(emptyState("jobs", "'payments'")).toBe("No jobs matched 'payments'");
    expect(emptyState("queued items")).toBe("No queued items found");
  });
});

describe("next hints (AGNT-04)", () => {
  it("appends one next: line per hint", () => {
    expect(withNext("body", ["do x", "do y"])).toBe("body\nnext: do x\nnext: do y");
  });

  it("caps hints at three, past which they stop being guidance", () => {
    const rendered = withNext("body", ["a", "b", "c", "d", "e"]);
    expect(rendered.split("next: ").length - 1).toBe(3);
  });

  it("leaves the body untouched when there is nothing useful to suggest", () => {
    expect(withNext("body", [])).toBe("body");
    expect(withNext("body", [""])).toBe("body");
  });
});

describe("truncation (AGNT-04)", () => {
  it("ends with the size hint and the exact next call, not a vague pointer", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

    const rendered = truncateLines(text, 3, "jenkins_log(mode='range', from=4)");

    expect(rendered).toBe(
      [
        "line 1",
        "line 2",
        "line 3",
        "[showing 3 of 10 lines — next: jenkins_log(mode='range', from=4)]",
      ].join("\n"),
    );
  });

  it("does not annotate text that fits", () => {
    expect(truncateLines("a\nb", 5, "call")).toBe("a\nb");
  });

  it("caps by UTF-8 bytes, since a context budget is spent in bytes", () => {
    const rendered = capBytes("a".repeat(100), 10, "narrow it");

    expect(rendered).toContain("[truncated 90 of 100 bytes — next: narrow it]");
    expect(rendered.split("\n")[0]).toBe("a".repeat(10));
  });

  it("numbers lines with right-aligned, consistent-width numbers", () => {
    expect(numberLines("a\nb", 9)).toBe(" 9  a\n10  b");
  });
});

describe("structured errors (AGNT-05)", () => {
  it("renders code, message and the recovery call on one line", () => {
    const err = new JenkinsError("Job not found.", "jenkins_job", 404, "not_found", "{findJobs}");

    expect(formatErrorLine(err)).toBe("error: not_found — Job not found. — try: {findJobs}");
  });

  it("derives the code from the HTTP status when none was given", () => {
    expect(formatErrorLine(new JenkinsError("nope", "op", 401))).toContain("error: auth_failed");
    expect(formatErrorLine(new JenkinsError("nope", "op", 403))).toContain("error: forbidden");
    expect(formatErrorLine(new JenkinsError("nope", "op", 500))).toContain("error: http_error");
    expect(formatErrorLine(new JenkinsError("nope", "op"))).toContain("error: unreachable");
  });

  it("withholds an unknown thrown value's own message, which may echo request details", () => {
    const rendered = formatErrorLine(new Error("token=abcd1234 failed"));

    expect(rendered).toBe("error: internal — An unexpected error occurred");
    expect(rendered).not.toContain("abcd1234");
  });
});

describe("applyCommandRefs", () => {
  const vocab: CommandVocabulary = {
    whoami: "jenkins_whoami",
    findJobs: "jenkins_find_jobs",
    job: "jenkins_job",
    build: "jenkins_build",
    log: "jenkins_log",
    queue: "jenkins_queue",
    trigger: "jenkins_trigger_build",
    abort: "jenkins_abort_build",
    diagnose: "jenkins_diagnose_build",
    wait: "jenkins_wait_build",
  };

  it("resolves every placeholder to the adapter's own vocabulary", () => {
    expect(applyCommandRefs("try {build} then {log}", vocab)).toBe(
      "try jenkins_build then jenkins_log",
    );
  });

  it("leaves an unknown brace expression alone rather than mangling it", () => {
    expect(applyCommandRefs("literal {notARef} stays", vocab)).toBe("literal {notARef} stays");
  });
});

describe("compact durations and ages", () => {
  it("renders durations at the precision a reader actually wants", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1400)).toBe("1.4s");
    expect(formatDuration(200_000)).toBe("3m20s");
    expect(formatDuration(3_840_000)).toBe("1h04m");
    expect(formatDuration(undefined)).toBe("-");
  });

  it("renders ages relative to now, which is what a build list is scanned for", () => {
    const now = 1_700_000_000_000;
    expect(formatAge(now - 30_000, now)).toBe("30s");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(formatAge(undefined, now)).toBe("-");
  });
});

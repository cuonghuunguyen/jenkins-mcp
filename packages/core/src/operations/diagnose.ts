/**
 * Failure diagnosis (DIAG-03).
 *
 * Answers "why did this build fail" from the two sources that actually know:
 * the failed pipeline step's own log, and the JUnit report naming the tests
 * that failed. Both are cheap, both are precise, and neither guesses.
 *
 * The cascade, in order:
 *
 * 1. `wfapi/describe` -> `findFailedNode` -> the node's OWN `_links.log.href`.
 *    Never a hand-built node-log URL: the href is the only thing that knows
 *    the flow-node id encoding.
 * 2. The JUnit report, ALWAYS, in addition to step 1 rather than instead of
 *    it - a pipeline that fails because tests failed has the answer here and
 *    a step log full of surefire noise. A non-ok response (404 = no JUnit
 *    publisher, the common case) means "no test report", never an error.
 * 3. Only when neither yielded anything: the tail of `consoleText`, labelled
 *    as the fallback it is.
 *
 * A freestyle build, and a pipeline on an instance without the wfapi plugin,
 * both get steps 2 and 3 rather than a dead end - they have no stage
 * attribution, but they still have a console log and possibly a test report.
 * That is the `log-only` state.
 *
 * v1's middle step - a regex scan of the whole console for the last
 * `error|failed|exception` marker - is deleted. On a normal build the last
 * marker is a compiler warning, a retried flake, or the word "error" inside a
 * dependency name, so it answered confidently and wrongly, which is worse
 * than not answering.
 *
 * Every fetch is `client.get()`; the module never issues a write (SAFE-01).
 */

import { buildKey, type JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";
import { isMultibranchJob, loadJobIndex } from "./jobs.js";
import { readWfapiNodeLog } from "./log.js";

/**
 * True iff `buildClass` (a BUILD's own `_class`, e.g.
 * `"org.jenkinsci.plugins.workflow.job.WorkflowRun"`) indicates a pipeline
 * build. Deliberately distinct from the job-level check in `jobs.ts`, which
 * tests for `"WorkflowJob"`/`"MultiBranch"`: reusing that one here would
 * misclassify every pipeline BUILD as freestyle.
 */
export function isPipelineBuildClass(buildClass: string | undefined): boolean {
  return typeof buildClass === "string" && buildClass.includes("WorkflowRun");
}

/**
 * One `stageFlowNodes[]` entry from `/wfapi/describe`. Every field beyond
 * `id` is optional and parsed defensively - the live shape is documented
 * only by example, so a missing field must degrade rather than throw.
 */
export interface WfapiNode {
  id: string;
  name?: string;
  status?: string;
  error?: { message?: string; type?: string };
  _links?: { log?: { href?: string } };
}

/** One `stages[]` entry from `/wfapi/describe`. */
export interface WfapiStage {
  id: string;
  name: string;
  status: string;
  stageFlowNodes?: WfapiNode[];
}

/** The parsed shape of a `/wfapi/describe` response. */
export interface WfapiDescribe {
  stages?: WfapiStage[];
}

/**
 * Hard upper bound on the region text an operation will hold and hand back
 * (500KB). This is NOT the display cap - `format/diagnose.ts` owns that, so
 * a `--json` caller gets real data rather than a string with a truncation
 * marker baked into it. This bound exists only so a pathological multi-
 * hundred-megabyte console log never becomes a resident string.
 *
 * ponytail: the response body is still buffered by `res.text()` before the
 * slice; stream `res.body` and stop early if a log that size ever shows up.
 */
export const REGION_HARD_CAP_BYTES = 512_000;

/** Failed test cases carried inline before the caller has to ask for more. */
export const DIAGNOSE_FAILED_TEST_CAP = 10;

/**
 * `tree=` projection for the JUnit report. Wider than `build-detail.ts`'s by
 * `errorStackTrace`, which is the only detail some assertion libraries write.
 */
const TEST_REPORT_TREE =
  "failCount,totalCount,suites[cases[className,name,status,errorDetails,errorStackTrace]]";

/** JUnit case statuses that count as a failure. */
const FAILED_TEST_STATUSES = new Set(["FAILED", "REGRESSION"]);

/** Which cascade branch produced the returned log region. */
export type DiagnoseRegionSource = "failed-step" | "console-tail";

/** A log region plus the truth about how big it really was. */
export interface DiagnoseRegion {
  source: DiagnoseRegionSource;
  /** Region text, bounded at `REGION_HARD_CAP_BYTES`. Not display-capped. */
  text: string;
  /** Byte length of the region BEFORE the hard bound - the honest size. */
  bytes: number;
  /**
   * 1-based line number of the region's FIRST line in the source it was cut
   * from. A console tail cut from the end of a 3000-line log starts at ~2900,
   * not at 1; numbering it from 1 makes every line number an agent reads out
   * of a diagnosis address the wrong part of the log (`format/log.ts` states
   * the opposite invariant for the whole project). A `failed-step` region is
   * its own log, so it genuinely starts at 1.
   */
  startLine: number;
  /**
   * `failed-step` only: which body shape the wfapi node-log endpoint actually
   * returned. Recorded because the live shape is unverified.
   */
  wfapiShape?: "json" | "text";
}

export interface DiagnoseFailedTest {
  className: string;
  name: string;
  detail?: string;
}

export interface DiagnoseTests {
  failCount: number;
  totalCount: number;
  /** Failed cases, capped at `DIAGNOSE_FAILED_TEST_CAP`. */
  failed: DiagnoseFailedTest[];
  /** Failed cases found before the cap - what `showing N of M` reports. */
  failedTotal: number;
}

// ---------------------------------------------------------------------------
// Wire shapes (local: core's shared `types.ts` is not this module's to extend)
// ---------------------------------------------------------------------------

interface BuildApiJson {
  _class?: string;
  number?: number;
  result?: string | null;
  building?: boolean;
  url?: string;
}

interface ApiTestCase {
  className?: string;
  name?: string;
  status?: string;
  errorDetails?: string;
  errorStackTrace?: string;
}

interface ApiTestReport {
  failCount?: number;
  totalCount?: number;
  suites?: Array<{ cases?: ApiTestCase[] }>;
}

// ---------------------------------------------------------------------------
// Returned shape
// ---------------------------------------------------------------------------

export interface DiagnoseArgs {
  job: string;
  ref?: string;
  /**
   * Index depth, used only to decide whether a bare-integer `ref` means a PR
   * (REF-01) - `refSchema` promises the agent that '42' is 'PR-42'.
   */
  depth?: number;
  /** Build number, -1, or a permalink alias (REF-01). Defaults to the last build. */
  build?: string | number;
}

/** Fields every branch carries, so the caller always knows what it looked at. */
interface DiagnoseIdentity {
  job: string;
  ref?: string;
  /** The selector as resolved for the URL - a number, or a permalink alias. */
  selector: string;
  number?: number;
  url?: string;
}

/** The build has not finished, so there is nothing to diagnose yet. */
export interface DiagnoseNotFinished extends DiagnoseIdentity {
  state: "not-finished";
  result: null;
}

/** The build succeeded - nothing to diagnose. */
export interface DiagnoseSuccess extends DiagnoseIdentity {
  state: "success";
  result: "SUCCESS";
}

/** What both failure branches carry. */
interface DiagnoseFailure extends DiagnoseIdentity {
  result: string | null | undefined;
  /** `undefined` = no test report published; present = a report was read. */
  tests?: DiagnoseTests;
  /** `undefined` = no log region could be extracted at all. */
  region?: DiagnoseRegion;
}

/** The build failed and wfapi named the stage and step that did it. */
export interface DiagnoseDiagnosed extends DiagnoseFailure {
  state: "diagnosed";
  failedStage?: string;
  failedStep?: string;
}

/**
 * The build failed and no stage attribution was available - a freestyle
 * build, or a pipeline on an instance without the wfapi plugin. Named for
 * what the caller GETS (a log, and maybe tests) rather than what the build is
 * not, because v1's `not-a-pipeline` read as a dead end and was treated as
 * one.
 */
export interface DiagnoseLogOnly extends DiagnoseFailure {
  state: "log-only";
  reason: "freestyle" | "wfapi-unavailable";
}

/**
 * Discriminated union on `state`: a non-failure branch cannot carry a
 * fabricated region or test list at the type level.
 */
export type DiagnoseResult =
  | DiagnoseNotFinished
  | DiagnoseSuccess
  | DiagnoseDiagnosed
  | DiagnoseLogOnly;

// ---------------------------------------------------------------------------
// Cascade pieces
// ---------------------------------------------------------------------------

/**
 * The first node carrying an `error` object or `status === "FAILED"`, paired
 * with its owning stage. The caller fetches that node's log via its OWN
 * `_links.log.href`; this never hand-builds a log URL.
 */
export function findFailedNode(
  describe: WfapiDescribe,
): { stage: WfapiStage; node: WfapiNode } | undefined {
  for (const stage of describe.stages ?? []) {
    for (const node of stage.stageFlowNodes ?? []) {
      if (node.error || node.status === "FAILED") {
        return { stage, node };
      }
    }
  }
  return undefined;
}

/**
 * Bounds `text` at `REGION_HARD_CAP_BYTES` while reporting its true size. A
 * console tail keeps the END (the failure is there); a step log keeps the
 * start, since the step's own log begins at the step.
 */
function toRegion(text: string, source: DiagnoseRegionSource): DiagnoseRegion {
  const buf = Buffer.from(text, "utf8");
  const totalLines = countLines(text);

  if (buf.length <= REGION_HARD_CAP_BYTES) {
    return { source, text, bytes: buf.length, startLine: 1 };
  }

  let kept: Buffer;
  if (source === "console-tail") {
    // Align FORWARD to a codepoint boundary. Slicing a UTF-8 buffer at a raw
    // byte offset decodes the straddling character to U+FFFD - `capBytes` in
    // format/common.ts backs off for exactly this reason, and a second
    // implementation that does not is a second bug. A continuation byte is
    // 0b10xxxxxx; at most three precede a boundary.
    let start = buf.length - REGION_HARD_CAP_BYTES;
    while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
    kept = buf.subarray(start);
  } else {
    let end = REGION_HARD_CAP_BYTES;
    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
    kept = buf.subarray(0, end);
  }

  const keptText = kept.toString("utf8");
  return {
    source,
    text: keptText,
    bytes: buf.length,
    // A console tail cut from the end starts partway down the real log.
    startLine: source === "console-tail" ? Math.max(1, totalLines - countLines(keptText) + 1) : 1,
  };
}

/** Lines in `text`, ignoring the single trailing newline Jenkins always sends. */
function countLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/\r?\n$/, "").split("\n").length;
}

/**
 * Fetches a log region, or `undefined` when there is none to be had.
 *
 * DEGRADES rather than throws, mirroring `fetchFailedTests` below. Throwing
 * here aborted the whole diagnosis over an optional source: a node log that
 * 404s took the test report and the console tail down with it, and a console
 * log discarded by a log-rotation policy turned the honest
 * `emptyState("log region", ...)` branch into `error: not_found` for a build
 * whose failure was fully readable by other means.
 */
async function fetchRegion(
  client: JenkinsClient,
  path: string,
  source: DiagnoseRegionSource,
): Promise<DiagnoseRegion | undefined> {
  try {
    const res = await client.get(path);
    if (!res.ok) return undefined;
    const body = await res.text();
    if (body === "") return undefined;

    // A wfapi node log answers with a `{ text: ... }` JSON envelope on some
    // instances and plain text on others; `readWfapiNodeLog` is the ONE reader
    // both this module and `operations/log.ts` use, so the two can no longer
    // disagree about the shape.
    if (source === "failed-step") {
      const parsed = readWfapiNodeLog(body);
      if (parsed.text === "") return undefined;
      return { ...toRegion(parsed.text, source), wfapiShape: parsed.shape };
    }
    return toRegion(body, source);
  } catch {
    return undefined;
  }
}

/**
 * Reads the JUnit report, or `undefined` when there is none.
 *
 * ponytail: a near-duplicate of `fetchTests` in `operations/build-detail.ts`,
 * which is not exported and uses a narrower `tree=` and a larger cap. Collapse
 * the two once `build-detail.ts` exports a reusable shape.
 */
async function fetchFailedTests(
  client: JenkinsClient,
  base: string,
): Promise<DiagnoseTests | undefined> {
  try {
    const res = await client.get(`${base}/testReport/api/json?tree=${TEST_REPORT_TREE}`);
    // 404 means no JUnit publisher ran, which is ordinary, not an error.
    if (!res.ok) return undefined;
    const body = (await res.json()) as ApiTestReport;

    const failed: DiagnoseFailedTest[] = [];
    for (const suite of body.suites ?? []) {
      for (const testCase of suite.cases ?? []) {
        if (testCase.status === undefined) continue;
        if (!FAILED_TEST_STATUSES.has(testCase.status)) continue;
        failed.push({
          className: testCase.className ?? "?",
          name: testCase.name ?? "?",
          detail: testCase.errorDetails ?? testCase.errorStackTrace,
        });
      }
    }

    return {
      failCount: body.failCount ?? failed.length,
      totalCount: body.totalCount ?? 0,
      failed: failed.slice(0, DIAGNOSE_FAILED_TEST_CAP),
      failedTotal: failed.length,
    };
  } catch {
    return undefined;
  }
}

/**
 * Runs the full cascade for one build.
 *
 * The build probe is cached on the same criterion `getBuildDetail` uses: a
 * plain build NUMBER whose `building` is false can never change again, while a
 * permalink alias stays volatile even when it currently resolves to a finished
 * build, because a new build moves the alias itself. The log and test-report
 * fetches are NOT cached - they are large and read once.
 */
export async function diagnoseBuild(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: DiagnoseArgs,
): Promise<DiagnoseResult> {
  const selector = resolveBuildSelector(args.build);
  const isNumeric = /^\d+$/.test(selector);
  const ref =
    args.depth !== undefined && /^\d+$/.test(String(args.ref ?? ""))
      ? normalizeRef(
          args.ref,
          isMultibranchJob(await loadJobIndex(client, cache, args.depth), args.job),
        )
      : args.ref;
  const base = `${jobRestPath(args.job, ref)}/${selector}`;

  const build = await cache.fetch(
    buildKey(args.job, ref, selector, "diagnose"),
    async () => {
      const res = await client.get(`${base}/api/json?tree=_class,number,result,building,url`);
      if (!res.ok) throw normalizeError(res, "jenkins_diagnose_build:build-api");
      return (await res.json()) as BuildApiJson;
    },
    (body) => (isNumeric && body.building !== true ? "permanent" : "volatile"),
  );

  const identity: DiagnoseIdentity = {
    job: args.job,
    ref,
    selector,
    number: build.number,
    url: build.url,
  };

  if (build.building === true || build.result === null || build.result === undefined) {
    return { ...identity, state: "not-finished", result: null };
  }

  if (build.result === "SUCCESS") {
    return { ...identity, state: "success", result: "SUCCESS" };
  }

  // Classify BEFORE calling wfapi: asking a freestyle build costs a
  // guaranteed 404.
  let failed: { stage: WfapiStage; node: WfapiNode } | undefined;
  let noStageData: DiagnoseLogOnly["reason"] | undefined;

  if (!isPipelineBuildClass(build._class)) {
    noStageData = "freestyle";
  } else {
    const wfapiRes = await client.get(`${base}/wfapi/describe`);
    if (wfapiRes.status === 404) {
      noStageData = "wfapi-unavailable";
    } else if (!wfapiRes.ok) {
      throw normalizeError(wfapiRes, "jenkins_diagnose_build:wfapi");
    } else {
      failed = findFailedNode((await wfapiRes.json()) as WfapiDescribe);
    }
  }

  // Cascade 1: the failed node's own log, followed via its OWN href.
  const nodeLogHref = failed?.node._links?.log?.href;
  let region = nodeLogHref ? await fetchRegion(client, nodeLogHref, "failed-step") : undefined;

  // Cascade 2: the failed tests. Runs in addition to cascade 1, not instead
  // of it - a green step log and a red test report is the normal shape of a
  // test failure.
  const tests = await fetchFailedTests(client, base);

  // Cascade 3: only when neither of the precise sources said anything.
  if (region === undefined && (tests === undefined || tests.failedTotal === 0)) {
    region = await fetchRegion(client, `${base}/consoleText`, "console-tail");
  }

  if (noStageData !== undefined) {
    return {
      ...identity,
      state: "log-only",
      reason: noStageData,
      result: build.result,
      tests,
      region,
    };
  }

  return {
    ...identity,
    state: "diagnosed",
    result: build.result,
    failedStage: failed?.stage.name,
    failedStep: failed?.node.name,
    tests,
    region,
  };
}

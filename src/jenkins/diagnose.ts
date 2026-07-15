/**
 * Failure-diagnosis extraction module (DIAG-01/DIAG-02, D-01/D-03/D-04/D-05/
 * D-06/D-07/D-08/D-09/D-10).
 *
 * Pure orchestration over already-existing choke points — `client.get()`
 * only (no write/POST call is ever issued, D-01), `jobPath(parsePathString(...))` for
 * every REST path (`../jenkins/paths.js`), and `normalizeError(res, label)`
 * for every non-ok response (`../jenkins/errors.js`). No MCP/CallToolResult
 * types live here (mirrors `queue.ts`'s separation from `trigger.ts`); the
 * thin `src/tools/diagnose.ts` adapter wraps `diagnoseBuild` for MCP.
 *
 * `diagnoseBuild` implements the cascade:
 *   1. Fetch the build's own `api.json` (`_class`/`result`/`building`/`url`).
 *      Still-building/queued or SUCCESS -> honest non-failure branch, never
 *      a fabricated failure/log region (D-04).
 *   2. On a failure result, probe `_class` BEFORE ever calling `wfapi`
 *      (Pitfall 9/10). A non-pipeline (freestyle) build short-circuits with
 *      a distinct message and NO wfapi request (D-09).
 *   3. For a pipeline build, fetch `/wfapi/describe`. A 404 here (the wfapi
 *      plugin not installed) is special-cased BEFORE the generic
 *      `normalizeError` throw, mirroring `vfs.ts`'s wfapi-404 handling, and
 *      returns a message distinct from the freestyle one (D-10).
 *   4. Walk `stages[].stageFlowNodes[]` for the first failed node
 *      (`findFailedNode`). If it carries its own log href, fetch THAT href
 *      (never a hand-built node-log URL) — a non-empty result is the
 *      precise "cascade 1" answer.
 *   5. Otherwise fall back to `consoleText`: marker-scan for the last error
 *      marker with a bounded context window (`extractMarkerRegion`, cascade
 *      2, D-07), and if no marker matches, tail the log (`tailRegion`,
 *      cascade 3, D-06).
 *
 * Every cascade branch's output is passed through `applyRegionCap` /
 * `tailRegion`'s own byte-cap logic (~18KB, `REGION_CAP_BYTES`) — including
 * the "precise" node-log branch, which is easy to assume is inherently small
 * but is not (RESEARCH.md Pitfall 3). The tool never returns a raw whole-log
 * dump on any branch (DIAG-02).
 */

import type { JenkinsClient } from "./client.js";
import { normalizeError } from "./errors.js";
import { jobPath, parsePathString } from "./paths.js";

/**
 * True iff `buildClass` (a BUILD's own `_class`, e.g.
 * `"org.jenkinsci.plugins.workflow.job.WorkflowRun"`) indicates a pipeline
 * build. This is a NEW build-level sibling to the job-level pipeline-class
 * check already in `vfs.ts` (which tests for `"WorkflowJob"`/`"MultiBranch"`
 * — a different string, since that function inspects a JOB's `_class`, not a
 * BUILD's). Reusing the job-level check here would misclassify every
 * pipeline build as freestyle (RESEARCH.md Pitfall 2) — hence a distinctly
 * named, standalone function instead.
 */
export function isPipelineBuildClass(buildClass: string | undefined): boolean {
  return typeof buildClass === "string" && buildClass.includes("WorkflowRun");
}

/**
 * One `stageFlowNodes[]` entry from `/wfapi/describe`. Every field beyond
 * `id` is optional — the live shape is MEDIUM confidence (RESEARCH.md
 * Assumption A1) and is parsed defensively via optional chaining throughout
 * this module, never assumed present.
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
 * Region byte cap (~18KB), comfortably under `jenkins_bash`'s ~50KB cap
 * (D-07/D-08). Exact value is planner discretion.
 */
export const REGION_CAP_BYTES = 18_000;

/**
 * Caps `text` at `capBytes` UTF-8 bytes (from the start), appending a
 * truncation notice reporting the dropped byte count when exceeded. Mirrors
 * `bash.ts`'s `applyOutputCap` shape. Returns `text` unchanged when already
 * within the cap.
 */
export function applyRegionCap(text: string, capBytes: number = REGION_CAP_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= capBytes) return text;
  const droppedBytes = buf.length - capBytes;
  return (
    `${buf.subarray(0, capBytes).toString("utf8")}\n` +
    `[truncated ${droppedBytes} bytes — use jenkins_bash for a wider read]`
  );
}

/**
 * Iterates `describe.stages ?? []` and, within each stage's
 * `stageFlowNodes ?? []`, returns the first node carrying an `error` object
 * OR `status === "FAILED"`, paired with its owning stage. Returns
 * `undefined` when no stage/node is found (e.g. an empty/malformed
 * describe). The caller fetches the returned node's log via its OWN
 * `_links.log.href` — this function never hand-builds a log URL.
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

/** Case-insensitive marker set anchoring the marker-scan fallback (D-07). */
const MARKER_RE = /error|fail(?:ed|ure)|exception|BUILD FAILED|exit code [1-9]/i;

/**
 * Case-insensitive scan for the LAST line matching `MARKER_RE` over `log`
 * (split on `\n`), returning a context window of `linesBefore` lines before
 * it through `linesAfter` lines after it, joined by `\n` and passed through
 * `applyRegionCap`. Returns `undefined` when no line matches (cascade 2,
 * D-07) — the caller falls through to `tailRegion` (cascade 3).
 */
export function extractMarkerRegion(
  log: string,
  linesBefore = 80,
  linesAfter = 20,
  capBytes: number = REGION_CAP_BYTES,
): string | undefined {
  const lines = log.split("\n");
  let lastMatchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_RE.test(lines[i] ?? "")) lastMatchIdx = i;
  }
  if (lastMatchIdx === -1) return undefined;

  const start = Math.max(0, lastMatchIdx - linesBefore);
  const end = Math.min(lines.length, lastMatchIdx + linesAfter + 1);
  const region = lines.slice(start, end).join("\n");
  return applyRegionCap(region, capBytes);
}

/**
 * Returns the last `capBytes` UTF-8 bytes of `log`, with a leading
 * truncation notice when the log exceeded the cap. Cascade 3 (D-06) —
 * always yields something when `log` is non-empty, since it is the final
 * fallback after the marker-scan found nothing.
 */
export function tailRegion(log: string, capBytes: number = REGION_CAP_BYTES): string {
  const buf = Buffer.from(log, "utf8");
  if (buf.length <= capBytes) return log;
  const droppedBytes = buf.length - capBytes;
  return (
    `[truncated ${droppedBytes} earlier bytes — showing the tail; use jenkins_bash for a wider read]\n` +
    buf.subarray(buf.length - capBytes).toString("utf8")
  );
}

/**
 * Arguments accepted by `diagnoseBuild`. `path` selects the job (folder-
 * nested form, e.g. `"folderA/my-job"`); `build` is the optional target
 * build number, defaulting to `lastBuild` when omitted (D-05). NOTE: the
 * job `path` selector is not in RESEARCH.md's `{ build?: number }` sketch —
 * a job must still be identified to diagnose one of its builds, so `path`
 * is added here (mirrors `trigger.ts`'s `TriggerArgs.path`), which is
 * planner discretion under D-03/D-05 (D-05 only locks that `build` is
 * optional and defaults to `lastBuild`).
 */
export interface DiagnoseArgs {
  path: string;
  build?: number;
}

/** The build did not finish yet (still building, or queued/no result) — D-04. */
export interface DiagnoseNotFinished {
  state: "not-finished";
  result: null;
  url?: string;
  hint: string;
}

/** The build succeeded — nothing to diagnose (D-04). */
export interface DiagnoseSuccess {
  state: "success";
  result: "SUCCESS";
  url?: string;
  hint: string;
}

/** The build failed but is not a pipeline build — stage diagnosis out of v1 scope (D-09). */
export interface DiagnoseNotAPipeline {
  state: "not-a-pipeline";
  result: string | null | undefined;
  url?: string;
  hint: string;
}

/** The build failed, is a pipeline build, but this Jenkins lacks the wfapi plugin (D-10). */
export interface DiagnoseWfapiUnavailable {
  state: "wfapi-unavailable";
  result: string | null | undefined;
  url?: string;
  hint: string;
}

/**
 * The build failed, is a pipeline build, and a bounded log region was
 * extracted via the D-06 cascade (D-03 return contract). `failedStage`/
 * `failedStep` are present only when `findFailedNode` located a failed
 * node; `logRegion` is always present and always byte-capped.
 */
export interface DiagnoseDiagnosed {
  state: "diagnosed";
  result: string | null | undefined;
  failedStage?: string;
  failedStep?: string;
  logRegion: string;
  url?: string;
  hint: string;
}

/**
 * Discriminated union on `state` (mirrors `trigger.ts`'s `TriggerResult`
 * discipline) — a non-failure branch can never carry a fabricated
 * `logRegion` at the type level (D-04).
 */
export type DiagnoseResult =
  | DiagnoseNotFinished
  | DiagnoseSuccess
  | DiagnoseNotAPipeline
  | DiagnoseWfapiUnavailable
  | DiagnoseDiagnosed;

/** The parsed shape of a build's `api.json?tree=_class,result,building,url` response. */
interface BuildApiJson {
  _class?: string;
  result?: string | null;
  building?: boolean;
  url?: string;
}

/** Hint pointing back at `jenkins_bash` for deeper/wider reads (D-08). */
const BASH_HINT =
  "Use jenkins_bash for deeper/wider reads (cat/grep/tail over builds/<n>/log, " +
  "cat builds/<n>/wfapi.json).";

/**
 * Orchestrates the full diagnosis cascade for one build. Every fetch is
 * `client.get()` (D-01, read-only) and every REST path is built via
 * `jobPath(parsePathString(args.path))` from `paths.ts` — never
 * hand-concatenated. Every non-ok response routes through
 * `normalizeError(res, label)`, with the wfapi 404 special-cased BEFORE the
 * generic throw (D-10, mirrors `vfs.ts`).
 */
export async function diagnoseBuild(
  client: JenkinsClient,
  args: DiagnoseArgs,
): Promise<DiagnoseResult> {
  const buildSegment = args.build ?? "lastBuild";
  const buildRestPath = `/job/${jobPath(parsePathString(args.path))}/${buildSegment}`;

  const buildRes = await client.get(`${buildRestPath}/api/json?tree=_class,result,building,url`);
  if (!buildRes.ok) throw normalizeError(buildRes, "jenkins_diagnose_build:build-api");
  const build = (await buildRes.json()) as BuildApiJson;

  if (build.building || build.result === null || build.result === undefined) {
    return {
      state: "not-finished",
      result: null,
      url: build.url,
      hint:
        "This build has not finished yet (still building or queued) — nothing to " +
        "diagnose yet. Use jenkins_bash to poll builds/<n>/api.json for its status.",
    };
  }

  if (build.result === "SUCCESS") {
    return {
      state: "success",
      result: "SUCCESS",
      url: build.url,
      hint: "This build succeeded — nothing to diagnose.",
    };
  }

  // A failure result (FAILURE/UNSTABLE/ABORTED/etc.) — probe _class BEFORE
  // ever calling wfapi (Pitfall 9/10, D-09).
  if (!isPipelineBuildClass(build._class)) {
    return {
      state: "not-a-pipeline",
      result: build.result,
      url: build.url,
      hint:
        "Stage-level diagnosis requires a pipeline job. Use jenkins_bash to read the " +
        "log (cat builds/<n>/log).",
    };
  }

  const wfapiRes = await client.get(`${buildRestPath}/wfapi/describe`);
  if (wfapiRes.status === 404) {
    return {
      state: "wfapi-unavailable",
      result: build.result,
      url: build.url,
      hint:
        "This Jenkins lacks the Pipeline REST API (wfapi) plugin; stage diagnosis is " +
        "unavailable. Use jenkins_bash to read the log (cat builds/<n>/log).",
    };
  }
  if (!wfapiRes.ok) throw normalizeError(wfapiRes, "jenkins_diagnose_build:wfapi");
  const describe = (await wfapiRes.json()) as WfapiDescribe;

  const failed = findFailedNode(describe);

  // Cascade 1: the failed node's own log, followed via its OWN
  // _links.log.href — never a hand-built node-log URL.
  const nodeLogHref = failed?.node._links?.log?.href;
  if (nodeLogHref) {
    const nodeLogRes = await client.get(nodeLogHref);
    if (!nodeLogRes.ok) throw normalizeError(nodeLogRes, "jenkins_diagnose_build:node-log");
    const nodeLogText = await nodeLogRes.text();
    if (nodeLogText) {
      return {
        state: "diagnosed",
        result: build.result,
        failedStage: failed?.stage.name,
        failedStep: failed?.node.name,
        logRegion: applyRegionCap(nodeLogText),
        url: build.url,
        hint: BASH_HINT,
      };
    }
  }

  // Cascade 2/3: fall back to consoleText marker-scan, then tail.
  const consoleRes = await client.get(`${buildRestPath}/consoleText`);
  if (!consoleRes.ok) throw normalizeError(consoleRes, "jenkins_diagnose_build:consoleText");
  const consoleText = await consoleRes.text();

  const logRegion = extractMarkerRegion(consoleText) ?? tailRegion(consoleText);

  return {
    state: "diagnosed",
    result: build.result,
    failedStage: failed?.stage.name,
    failedStep: failed?.node.name,
    logRegion,
    url: build.url,
    hint: BASH_HINT,
  };
}

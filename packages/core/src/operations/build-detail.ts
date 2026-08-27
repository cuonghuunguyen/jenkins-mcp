/**
 * One-call build detail (READ-09).
 *
 * `getBuild` in `build.ts` answers "what happened"; this answers "why", in the
 * same round-trip budget an agent would otherwise spend on four tool calls:
 * status, cause, parameters, commits, stages, failed steps and failed tests.
 *
 * Three requests, only the first of which is required:
 *
 * 1. `api/json` - the build itself. A failure here is a real failure.
 * 2. `wfapi/describe` - pipeline stages. A freestyle build has no such
 *    endpoint (404) and an instance without the Pipeline REST API plugin has
 *    none either, so a non-ok response means "no stage data", not "error".
 * 3. `testReport/api/json` - JUnit results. Absent whenever no test publisher
 *    ran, which is the common case, so the same degrade-don't-fail rule holds.
 *
 * Absence is therefore recorded EXPLICITLY: `stages: undefined` means "no
 * stage data available", `stages: []` means "a pipeline with no stages". An
 * agent that cannot tell those apart reads a freestyle build as a pipeline
 * that did nothing.
 */

import { buildKey, type JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";
import { isPipelineBuildClass } from "./diagnose.js";
import { isMultibranchJob, loadJobIndex } from "./jobs.js";

/** Curated `tree=` projection for the detail read (D-06, READ-09). */
export const BUILD_DETAIL_TREE_FIELDS = [
  "number,result,building,duration,timestamp,url,queueId,_class",
  // `_class` on a parameter is what distinguishes a PasswordParameterValue from
  // an ordinary one; without it a secret cannot be recognised, let alone hidden.
  "actions[causes[shortDescription],parameters[_class,name,value]]",
  // Both spellings are requested: a WorkflowRun exposes `changeSets`, an
  // AbstractBuild (freestyle) exposes `changeSet`. UNVERIFIED which one a given
  // instance returns, so whichever is present is read - asking for both costs
  // nothing and dropping freestyle commits would render as "no commits".
  "changeSets[items[commitId,msg,author[fullName],date]]",
  "changeSet[items[commitId,msg,author[fullName],date]]",
].join(",");

/** `tree=` projection for the JUnit test report. */
export const TEST_REPORT_TREE_FIELDS =
  "failCount,totalCount,suites[cases[className,name,status,errorDetails]]";

/**
 * The outcome of an OPTIONAL enrichment request.
 *
 * `degraded` separates "Jenkins says this does not exist" (a 404 - a permanent
 * fact about the build) from "the request did not get through" (a timeout, a
 * 500, a proxy hiccup). Only the first is safe to cache forever; caching the
 * second blinds the tool to that build's stages or tests for the whole process
 * lifetime, with no way for a caller to force a refetch.
 */
interface Enrichment<T> {
  value?: T;
  degraded: boolean;
}

/** Failed tests carried in the result before the caller has to ask for more. */
export const FAILED_TEST_CAP = 20;

/** JUnit case statuses that count as a failure for reporting purposes. */
const FAILED_TEST_STATUSES = new Set(["FAILED", "REGRESSION"]);

// ---------------------------------------------------------------------------
// Wire shapes (local: core's shared `types.ts` is not ours to extend)
// ---------------------------------------------------------------------------

interface ApiCause {
  shortDescription?: string;
}

interface ApiParameter {
  _class?: string;
  name?: string;
  value?: unknown;
}

/**
 * Parameter classes whose value is a credential. Matched on the class name
 * rather than the parameter name, because a build's own naming is not a
 * security boundary.
 */
const SECRET_PARAMETER_CLASS_RE = /Password|Secret|Credentials/i;

/**
 * One `actions[]` entry. The array is heterogeneous - most entries carry
 * neither `causes` nor `parameters` (queue metadata, git revision, timings) -
 * so every consumer filters rather than indexing a fixed position.
 */
interface ApiAction {
  causes?: ApiCause[];
  parameters?: ApiParameter[];
}

interface ApiChangeSetItem {
  commitId?: string;
  msg?: string;
  author?: { fullName?: string };
  date?: string;
}

interface ApiChangeSet {
  items?: ApiChangeSetItem[];
}

interface ApiBuildDetail {
  number?: number;
  result?: string | null;
  building?: boolean;
  duration?: number;
  timestamp?: number;
  url?: string;
  queueId?: number;
  _class?: string;
  actions?: Array<ApiAction | null>;
  changeSets?: ApiChangeSet[];
  /** Freestyle (AbstractBuild) spelling of the same thing. */
  changeSet?: ApiChangeSet | ApiChangeSet[];
}

interface WfapiStage {
  id?: string;
  name?: string;
  status?: string;
  durationMillis?: number;
}

interface WfapiDescribe {
  stages?: WfapiStage[];
}

interface ApiTestCase {
  className?: string;
  name?: string;
  status?: string;
  errorDetails?: string;
}

interface ApiTestReport {
  failCount?: number;
  totalCount?: number;
  suites?: Array<{ cases?: ApiTestCase[] }>;
}

// ---------------------------------------------------------------------------
// Returned shape
// ---------------------------------------------------------------------------

export interface BuildParameter {
  name: string;
  value: string;
}

export interface BuildCommit {
  commitId: string;
  author?: string;
  message?: string;
  date?: string;
}

export interface BuildStage {
  name: string;
  status: string;
  durationMs?: number;
  id?: string;
}

export interface FailedTest {
  className: string;
  name: string;
  detail?: string;
}

export interface BuildTestReport {
  failCount: number;
  totalCount: number;
  /** Failed cases, capped at `FAILED_TEST_CAP`. */
  failed: FailedTest[];
  /** Failed cases found before the cap - what `showing N of M` reports. */
  failedTotal: number;
}

export interface BuildDetail {
  job: string;
  ref?: string;
  /** The selector as resolved for the URL - a number, or a permalink alias. */
  selector: string;
  number?: number;
  result: string | null;
  building: boolean;
  durationMs?: number;
  timestamp?: number;
  url?: string;
  queueId?: number;
  /** True when the build's `_class` is a pipeline run (`WorkflowRun`). */
  pipeline: boolean;
  causes: string[];
  parameters: BuildParameter[];
  commits: BuildCommit[];
  /** `undefined` = no stage data available; `[]` = a pipeline with no stages. */
  stages?: BuildStage[];
  /** `undefined` = no test report published; present = a report was read. */
  tests?: BuildTestReport;
  /**
   * True when an optional enrichment failed transiently, so this detail is
   * incomplete for a reason that may not repeat. Keeps it out of the permanent
   * cache tier.
   */
  degraded: boolean;
}

export interface BuildDetailArgs {
  job: string;
  ref?: string;
  build?: string | number;
  depth: number;
}

/** Every build cause across the heterogeneous `actions[]` array. */
function causesOf(body: ApiBuildDetail): string[] {
  const out: string[] = [];
  for (const action of body.actions ?? []) {
    for (const cause of action?.causes ?? []) {
      if (cause.shortDescription) out.push(cause.shortDescription);
    }
  }
  return out;
}

/** Renders a parameter value, which Jenkins may report as any JSON value. */
function renderParameterValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  // `String({})` is "[object Object]", which tells a caller nothing and cannot
  // be fed back into a trigger call.
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Every build parameter across `actions[]`, stringified for display.
 *
 * A credential-bearing parameter is redacted here rather than at the
 * formatter, because the returned value is also what `--json` prints and what
 * the permanent cache holds. Whether Jenkins exports a PasswordParameterValue's
 * `value` at all is UNVERIFIED against a live instance - redacting costs
 * nothing if it does not.
 */
function parametersOf(body: ApiBuildDetail): BuildParameter[] {
  const out: BuildParameter[] = [];
  for (const action of body.actions ?? []) {
    for (const param of action?.parameters ?? []) {
      if (param.name === undefined) continue;
      const secret = SECRET_PARAMETER_CLASS_RE.test(param._class ?? "");
      out.push({
        name: param.name,
        value: secret ? "[redacted]" : renderParameterValue(param.value),
      });
    }
  }
  return out;
}

/** Flattens `changeSets[].items[]` (or the freestyle `changeSet`) into commits. */
function commitsOf(body: ApiBuildDetail): BuildCommit[] {
  const freestyle = body.changeSet;
  const sets =
    body.changeSets ??
    (freestyle === undefined ? [] : Array.isArray(freestyle) ? freestyle : [freestyle]);

  const out: BuildCommit[] = [];
  for (const set of sets) {
    for (const item of set.items ?? []) {
      if (item.commitId === undefined) continue;
      out.push({
        commitId: item.commitId,
        author: item.author?.fullName,
        message: item.msg,
        date: item.date,
      });
    }
  }
  return out;
}

/**
 * Reads pipeline stages, or `undefined` when they are unavailable.
 *
 * Non-ok covers both "not a pipeline endpoint" (404 on a freestyle build) and
 * "no Pipeline REST API plugin installed"; a thrown request error is treated
 * the same way, because a missing optional enrichment must never fail the
 * whole read.
 */
async function fetchStages(client: JenkinsClient, base: string): Promise<Enrichment<BuildStage[]>> {
  try {
    const res = await client.get(`${base}/wfapi/describe`);
    if (!res.ok) return { degraded: res.status !== 404 };
    const body = (await res.json()) as WfapiDescribe;
    if (!Array.isArray(body.stages)) return { degraded: false };
    return {
      degraded: false,
      value: body.stages.map((stage) => ({
        name: stage.name ?? stage.id ?? "?",
        status: stage.status ?? "UNKNOWN",
        durationMs: stage.durationMillis,
        id: stage.id,
      })),
    };
  } catch {
    return { degraded: true };
  }
}

/** Reads the JUnit report, or `undefined` when no report exists. */
async function fetchTests(
  client: JenkinsClient,
  base: string,
): Promise<Enrichment<BuildTestReport>> {
  try {
    const res = await client.get(`${base}/testReport/api/json?tree=${TEST_REPORT_TREE_FIELDS}`);
    if (!res.ok) return { degraded: res.status !== 404 };
    const body = (await res.json()) as ApiTestReport;

    const failed: FailedTest[] = [];
    for (const suite of body.suites ?? []) {
      for (const testCase of suite.cases ?? []) {
        if (testCase.status === undefined) continue;
        if (!FAILED_TEST_STATUSES.has(testCase.status)) continue;
        failed.push({
          className: testCase.className ?? "?",
          name: testCase.name ?? "?",
          detail: testCase.errorDetails,
        });
      }
    }

    return {
      degraded: false,
      value: {
        failCount: body.failCount ?? failed.length,
        totalCount: body.totalCount ?? 0,
        failed: failed.slice(0, FAILED_TEST_CAP),
        failedTotal: failed.length,
      },
    };
  } catch {
    return { degraded: true };
  }
}

/**
 * Reads one build in full (READ-09).
 *
 * The cache tier is decided from the loaded value: a plain build NUMBER whose
 * `building` is false can never change again, so it is cached for the life of
 * the process. A permalink alias stays volatile even when it currently
 * resolves to a finished build, because a new build moves the alias itself.
 */
export async function getBuildDetail(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: BuildDetailArgs,
): Promise<BuildDetail> {
  // Resolved before any request, so a bad selector is an `invalid_input`
  // error rather than a wasted round trip.
  const selector = resolveBuildSelector(args.build);
  const isNumeric = /^\d+$/.test(selector);

  const index = await loadJobIndex(client, cache, args.depth);
  const ref = normalizeRef(args.ref, isMultibranchJob(index, args.job));

  return cache.fetch(
    buildKey(args.job, ref, selector, "detail"),
    async () => {
      const base = `${jobRestPath(args.job, ref)}/${selector}`;
      const res = await client.get(`${base}/api/json?tree=${BUILD_DETAIL_TREE_FIELDS}`);
      if (!res.ok) throw normalizeError(res, "jenkins_build");
      const body = (await res.json()) as ApiBuildDetail;

      const pipeline = isPipelineBuildClass(body._class);
      // wfapi only exists for pipeline runs; asking a freestyle build costs
      // a guaranteed 404, so classification comes first.
      const stages = pipeline ? await fetchStages(client, base) : { degraded: false };
      const tests = await fetchTests(client, base);

      return {
        job: args.job,
        ref,
        selector,
        number: body.number,
        result: body.result ?? null,
        building: body.building === true,
        durationMs: body.duration,
        timestamp: body.timestamp,
        url: body.url,
        queueId: body.queueId,
        pipeline,
        causes: causesOf(body),
        parameters: parametersOf(body),
        commits: commitsOf(body),
        stages: stages.value,
        tests: tests.value,
        degraded: stages.degraded || tests.degraded,
      };
    },
    (detail) => (isNumeric && !detail.building && !detail.degraded ? "permanent" : "volatile"),
  );
}

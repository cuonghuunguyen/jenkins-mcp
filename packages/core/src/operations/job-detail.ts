/**
 * One-job detail read (READ-08, REF-02).
 *
 * A caller asking about "a job" means one of two genuinely different things,
 * and which one it is depends on what the job actually is:
 *
 * - a multibranch parent or folder -> the useful answer is its children
 *   (branches, `PR-<n>`, tags), so an agent can pick a ref (REF-02);
 * - a buildable job -> the useful answer is how to build it (its parameters)
 *   plus what happened recently (the last 10 builds) (READ-08).
 *
 * Both are returned from one function under one type discriminated by `kind`,
 * because a caller does not know in advance which it is holding - that is the
 * whole question. The container answer costs zero extra HTTP requests: the job
 * index already materialized every child (AGNT-02), so it is a lookup, not a
 * fetch.
 */

import type { JenkinsCache } from "../cache.js";
import { jobKey } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, parsePathString } from "../paths.js";
import type { IndexedJob, JobType } from "../types.js";
import { isMultibranchJob, jobTypeOf, loadJobIndex } from "./jobs.js";

/**
 * Fields fetched for a buildable job. `{0,10}` is Jenkins' own range syntax on
 * the `builds` collection - it caps the list SERVER-side, which is the whole
 * point: a job with 8000 builds must not ship 8000 entries over the wire just
 * so the client can slice ten off the front.
 */
const DETAIL_TREE_FIELDS =
  "name,fullName,description,url,buildable,_class," +
  "property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]," +
  "builds[number,result,building,timestamp,duration]{0,10}," +
  // Free in the same request, and the only way to say how many builds the job
  // actually has: `builds` is capped server-side, so its length is not a total.
  "nextBuildNumber";

// ---------------------------------------------------------------------------
// Wire types (local to this operation, per ARCH-01)
// ---------------------------------------------------------------------------

interface ApiParameterDefinition {
  name?: string;
  /**
   * Jenkins reports the definition's simple class name here, e.g.
   * "StringParameterDefinition". Not verified against a live instance;
   * `simpleParameterType` degrades gracefully to the raw value if an instance
   * returns something else.
   */
  type?: string;
  description?: string | null;
  defaultParameterValue?: { value?: unknown } | null;
  choices?: string[];
}

interface ApiJobProperty {
  _class?: string;
  parameterDefinitions?: ApiParameterDefinition[];
}

interface ApiJobBuild {
  number?: number;
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  duration?: number;
}

interface ApiJobDetail {
  name?: string;
  fullName?: string;
  description?: string | null;
  url?: string;
  buildable?: boolean;
  _class?: string;
  property?: ApiJobProperty[];
  builds?: ApiJobBuild[];
  nextBuildNumber?: number;
}

// ---------------------------------------------------------------------------
// Returned data
// ---------------------------------------------------------------------------

/** One build parameter a caller can pass to `{trigger}`. */
export interface JobParameter {
  name: string;
  /** Coarse type, e.g. "string", "boolean", "choice". */
  type: string;
  description?: string;
  /** Default rendered as text; a parameter default may be any JSON scalar. */
  defaultValue?: string;
  /** Accepted values, for a choice parameter. */
  choices?: string[];
}

/** One entry of a job's recent-build list. */
export interface JobBuildSummary {
  number?: number;
  result: string | null;
  building: boolean;
  timestamp?: number;
  durationMs?: number;
}

/** A buildable job: how to build it, and what it built recently (READ-08). */
export interface JobDetailJob {
  kind: "job";
  /** The job fullName as asked for. */
  job: string;
  /** The normalized ref, when one was given. */
  ref?: string;
  /** Jenkins' own fullName for the addressed job (includes the ref level). */
  fullName: string;
  type: JobType;
  description?: string;
  url?: string;
  buildable: boolean;
  parameters: JobParameter[];
  builds: JobBuildSummary[];
  /**
   * Builds the job has run in total. `builds` is capped server-side at 10, so
   * without this a truncated list would render as a complete one.
   */
  totalBuilds?: number;
}

/** A multibranch parent or folder: its children (REF-02). */
export interface JobDetailContainer {
  kind: "container";
  job: string;
  type: JobType;
  /** Direct children only - one index level below the container. */
  children: IndexedJob[];
  total: number;
  depthCap: number;
  droppedFolders: string[];
}

export type JobDetail = JobDetailJob | JobDetailContainer;

export interface JobDetailArgs {
  job: string;
  ref?: string;
  depth: number;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Reduces "StringParameterDefinition" to "string". Falls through to the raw
 * value when an instance reports something this pattern does not cover, so an
 * unknown parameter plugin still shows a usable type rather than a blank.
 */
function simpleParameterType(type: string | undefined): string {
  if (type === undefined || type === "") return "unknown";
  const stripped = type.replace(/ParameterDefinition$/, "");
  return stripped === "" ? type : stripped.toLowerCase();
}

/** Renders a parameter default, which may be any JSON scalar, as text. */
function renderDefault(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Collects the job's build parameters.
 *
 * `property[]` is a mixed bag: an instance returns discard-policy, build-
 * discarder, GitHub-project and pipeline-trigger properties in the same array,
 * and a `tree=` projection renders each of them as `{}` rather than omitting
 * them. So the filter is on "carries parameterDefinitions", not on `_class` -
 * matching the ParametersDefinitionProperty class name would break on any
 * instance that renames or wraps it.
 */
function parametersOf(body: ApiJobDetail): JobParameter[] {
  const params: JobParameter[] = [];
  for (const property of body.property ?? []) {
    for (const definition of property.parameterDefinitions ?? []) {
      if (definition.name === undefined || definition.name === "") continue;
      params.push({
        name: definition.name,
        type: simpleParameterType(definition.type),
        description: definition.description ?? undefined,
        defaultValue: renderDefault(definition.defaultParameterValue?.value),
        choices: definition.choices,
      });
    }
  }
  return params;
}

function buildsOf(body: ApiJobDetail): JobBuildSummary[] {
  return (body.builds ?? []).map((build) => ({
    number: build.number,
    result: build.result ?? null,
    building: build.building === true,
    timestamp: build.timestamp,
    durationMs: build.duration,
  }));
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

/**
 * Reads one job.
 *
 * Returns the container shape for a multibranch parent or folder addressed
 * WITHOUT a ref, and the job shape otherwise - a ref names a specific
 * multibranch child, which is itself a buildable job.
 *
 * The ref goes through `normalizeRef` against the index first, so `ref: "42"`
 * becomes `PR-42` on a multibranch parent and is left alone anywhere else
 * (REF-01).
 *
 * Only the job shape is cached here, under `volatile`: the response embeds the
 * last 10 builds, so it is stale the moment a build starts. The container shape
 * is not cached a second time - it is derived entirely from `loadJobIndex`,
 * which already carries the 60s index tier.
 */
export async function getJobDetail(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: JobDetailArgs,
): Promise<JobDetail> {
  // Normalized once, here. `jobRestPath` and `parsePathString` both tolerate a
  // leading or trailing slash, so comparing the raw string against the index
  // made `svc/` miss its own entry: the container branch and `isMultibranchJob`
  // both silently turned off, and `ref: "42"` stopped becoming `PR-42`.
  const job = parsePathString(args.job).join("/");

  const index = await loadJobIndex(client, cache, args.depth);
  const ref = normalizeRef(args.ref, isMultibranchJob(index, job));

  if (ref === undefined) {
    const entry = index.jobs.find((candidate) => candidate.fullName === job);
    if (entry !== undefined && (entry.type === "multibranch" || entry.type === "folder")) {
      const prefix = `${job}/`;
      const children = index.jobs.filter(
        (candidate) => candidate.fullName.startsWith(prefix) && candidate.depth === entry.depth + 1,
      );
      return {
        kind: "container",
        job,
        type: entry.type,
        children,
        total: children.length,
        depthCap: index.depthCap,
        // Only this container's own dropped subtrees: annotating a fully
        // expanded listing with an unrelated subtree's cap implies that THIS
        // listing is incomplete.
        droppedFolders: index.droppedFolders.filter(
          (folder) => folder === job || folder.startsWith(prefix),
        ),
      };
    }
  }

  return cache.fetch(
    jobKey(job, ref, "detail"),
    async () => {
      const res = await client.get(`${jobRestPath(job, ref)}/api/json?tree=${DETAIL_TREE_FIELDS}`);
      if (!res.ok) throw normalizeError(res, "jenkins_job");
      const body = (await res.json()) as ApiJobDetail;

      const detail: JobDetailJob = {
        kind: "job",
        job,
        ref,
        fullName: body.fullName ?? (ref === undefined ? job : `${job}/${ref}`),
        type: jobTypeOf(body._class),
        description: body.description ?? undefined,
        url: body.url,
        // An instance omits `buildable` on some job classes; absent means the
        // job cannot be triggered, which is the safer reading to report.
        buildable: body.buildable === true,
        parameters: parametersOf(body),
        builds: buildsOf(body),
        totalBuilds:
          body.nextBuildNumber === undefined ? undefined : Math.max(0, body.nextBuildNumber - 1),
      };
      return detail;
    },
    "volatile",
  );
}

/**
 * One-request job index (AGNT-02).
 *
 * The v1 VFS paid one REST call per folder level and rebuilt the whole tree on
 * every tool call. This replaces both problems with a single nested `tree=`
 * request that materializes every job, folder, multibranch parent and
 * multibranch child (branches, `PR-<n>`, tags) in one round trip, cached for
 * 60s process-wide.
 *
 * The one thing a nested `tree=` cannot do is tell you what it did not
 * return: at the deepest requested level Jenkins simply omits the `jobs`
 * field, which looks identical to a leaf job. So containers found AT the depth
 * cap are recorded in `droppedFolders` and reported in the output - the index
 * is allowed to be incomplete, but never silently incomplete.
 */

import type { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import type {
  ApiJobEntry,
  ApiJobsResponse,
  IndexedJob,
  IndexedLastBuild,
  JobIndex,
  JobStatus,
  JobType,
} from "../types.js";

/** Fields fetched per job entry, at every nesting level. */
const INDEX_LEAF_FIELDS =
  "fullName,name,color,_class,url,scm[userRemoteConfigs[url]]," +
  // Criterion 1's `lastBuild` and `age` columns. This grows the index
  // RESPONSE; it does not add a request, which is the whole point of the
  // one-request index.
  "lastBuild[number,timestamp,result]";

/** Cache key for the whole index - one entry, refreshed as a unit. */
const INDEX_CACHE_KEY = "index:jobs";

/**
 * Builds the nested `tree=` query: `depth` levels of
 * `jobs[<fields>,jobs[<fields>,...]]`, with the deepest level omitting a
 * further `jobs[...]` sub-selector.
 */
export function buildIndexTreeQuery(depth: number): string {
  let inner = INDEX_LEAF_FIELDS;
  for (let level = 1; level < depth; level++) {
    inner = `${INDEX_LEAF_FIELDS},jobs[${inner}]`;
  }
  return `jobs[${inner}]`;
}

/**
 * True when a `_class` denotes a container that can hold child jobs: a plain
 * folder, an organization folder, or a multibranch project (whose children are
 * its branches, PRs and tags).
 *
 * Deliberately distinct from `isPipelineBuildClass` in diagnose.ts, which
 * tests a *build* class ("WorkflowRun") - applying that at job level
 * misclassifies everything.
 */
export function isContainerClass(jobClass: string | undefined): boolean {
  return (
    typeof jobClass === "string" &&
    (jobClass.includes("Folder") || jobClass.includes("MultiBranch"))
  );
}

/** Classifies a job entry's `_class` into a coarse, output-friendly type. */
export function jobTypeOf(jobClass: string | undefined): JobType {
  if (typeof jobClass !== "string") return "other";
  if (jobClass.includes("MultiBranch")) return "multibranch";
  if (jobClass.includes("Folder")) return "folder";
  if (jobClass.includes("WorkflowJob")) return "pipeline";
  if (jobClass.includes("FreeStyleProject")) return "freestyle";
  return "other";
}

/**
 * Maps Jenkins' ball `color` to a status. Jenkins appends `_anime` while a
 * build is running, so that suffix is checked first - a running job's colour
 * still names its *previous* result, which would otherwise be reported as the
 * current one.
 */
export function jobStatusOf(color: string | undefined): JobStatus {
  if (color === undefined) return "unknown";
  if (color.endsWith("_anime")) return "building";
  switch (color) {
    case "blue":
      return "success";
    case "yellow":
      return "unstable";
    case "red":
      return "failed";
    case "aborted":
      return "aborted";
    case "disabled":
      return "disabled";
    case "notbuilt":
      return "not_built";
    default:
      return "unknown";
  }
}

/**
 * The job's last build, or `undefined`. A folder has no builds and a job that
 * has never run has none either; both must render as "-" rather than as a
 * fabricated build number.
 */
function lastBuildOf(entry: ApiJobEntry): IndexedLastBuild | undefined {
  const last = entry.lastBuild;
  if (last === undefined || last === null || typeof last.number !== "number") return undefined;
  return { number: last.number, timestamp: last.timestamp, result: last.result ?? null };
}

/** Collects the git remote URLs declared by a job's SCM block. */
function scmUrlsOf(entry: ApiJobEntry): string[] {
  const configs = entry.scm?.userRemoteConfigs ?? [];
  return configs
    .map((config) => config.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

/**
 * Flattens the nested response into a flat job list, recording containers
 * that sit at the depth cap (and were therefore never expanded) rather than
 * treating them as leaves.
 */
function flatten(
  entries: ApiJobEntry[] | undefined,
  depth: number,
  depthCap: number,
  parentFullName: string | undefined,
  out: IndexedJob[],
  dropped: string[],
): void {
  for (const entry of entries ?? []) {
    // A nested `tree=` normally returns fullName at every level; fall back to
    // composing it from the parent so an instance that omits it still indexes.
    const name =
      entry.fullName ?? (parentFullName ? `${parentFullName}/${entry.name}` : entry.name);
    if (name === undefined) continue;

    out.push({
      fullName: name,
      type: jobTypeOf(entry._class),
      status: jobStatusOf(entry.color),
      url: entry.url,
      scmUrls: scmUrlsOf(entry),
      depth,
      lastBuild: lastBuildOf(entry),
    });

    if (entry.jobs !== undefined) {
      flatten(entry.jobs, depth + 1, depthCap, name, out, dropped);
    } else if (isContainerClass(entry._class) && depth >= depthCap) {
      // Jenkins omits `jobs` at the deepest requested level, which is
      // indistinguishable from a leaf job - so a container here means the cap
      // cut the walk short, not that the container is empty.
      dropped.push(name);
    }
  }
}

/**
 * Fetches and materializes the job index in one request, cached under the
 * 60s index tier.
 */
export async function loadJobIndex(
  client: JenkinsClient,
  cache: JenkinsCache,
  depth: number,
): Promise<JobIndex> {
  return cache.fetch(
    INDEX_CACHE_KEY,
    async () => {
      const res = await client.get(`/api/json?tree=${buildIndexTreeQuery(depth)}`);
      if (!res.ok) throw normalizeError(res, "jenkins_find_jobs:index");
      const body = (await res.json()) as ApiJobsResponse;

      const jobs: IndexedJob[] = [];
      const droppedFolders: string[] = [];
      flatten(body.jobs, 1, depth, undefined, jobs, droppedFolders);

      return { jobs, total: jobs.length, depthCap: depth, droppedFolders };
    },
    "index",
  );
}

/**
 * True when `job` is a multibranch parent according to the index - the
 * question `normalizeRef` needs answered before it can turn a bare integer
 * ref into `PR-<n>` (REF-01).
 */
export function isMultibranchJob(index: JobIndex, job: string): boolean {
  return index.jobs.some((entry) => entry.fullName === job && entry.type === "multibranch");
}

/** Result of a job search: the matches plus the index-wide totals (READ-07). */
export interface JobSearchResult {
  query?: string;
  matches: IndexedJob[];
  /** Matches found, before `limit` was applied. */
  matched: number;
  /** Jobs in the whole index. */
  total: number;
  depthCap: number;
  droppedFolders: string[];
}

/**
 * Normalizes a git remote URL for comparison: drops a trailing `.git`, strips
 * credentials, and lowercases. Lets `git remote get-url origin` output match a
 * job's configured SCM URL even when one side is SSH and the other HTTPS.
 */
function normalizeRemote(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/\.git$/, "");
}

/**
 * Finds jobs by fullName substring or SCM remote URL (READ-07).
 *
 * The SCM match is what lets an agent go straight from a checkout to its job:
 * `git remote get-url origin` output is matched against the index's
 * `userRemoteConfigs` URLs, so no name convention has to be guessed. An empty
 * query returns the head of the index rather than nothing, so the tool is
 * usable for browsing too.
 */
export async function findJobs(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: { query?: string; limit?: number; depth: number },
): Promise<JobSearchResult> {
  const index = await loadJobIndex(client, cache, args.depth);
  const limit = args.limit ?? 20;
  const query = args.query?.trim();

  if (query === undefined || query === "") {
    return {
      matches: index.jobs.slice(0, limit),
      matched: index.total,
      total: index.total,
      depthCap: index.depthCap,
      droppedFolders: index.droppedFolders,
    };
  }

  const needle = query.toLowerCase();
  const remoteNeedle = normalizeRemote(query);
  const matches = index.jobs.filter(
    (job) =>
      job.fullName.toLowerCase().includes(needle) ||
      job.scmUrls.some((url) => normalizeRemote(url) === remoteNeedle),
  );

  return {
    query,
    matches: matches.slice(0, limit),
    matched: matches.length,
    total: index.total,
    depthCap: index.depthCap,
    droppedFolders: index.droppedFolders,
  };
}

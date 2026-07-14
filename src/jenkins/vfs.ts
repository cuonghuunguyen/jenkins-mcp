/**
 * Jenkins-mirroring in-memory virtual filesystem (D-01, D-03).
 *
 * `buildJenkinsVfs(client)` issues exactly ONE recursive, name-only Jenkins
 * metadata fetch to materialize the full `/jobs/...` directory skeleton
 * (folders, jobs, multibranch branches) plus recent-build and
 * permalink-alias build directories, and `/queue.json` at the root
 * (D-03/D-03b/D-04). No log, stage, or per-build detail is fetched during
 * this skeleton phase — those are registered as `InMemoryFs` lazy file
 * providers (D-04) that fetch a curated Jenkins REST `tree=` projection
 * through the existing `JenkinsClient` on first read only, and are cached
 * for the remainder of the invocation (D-05/D-09).
 *
 * Every VFS-path-to-REST-path translation routes exclusively through
 * `jobPath(parsePathString(...))` from `./paths.js` — the choke point
 * established in Phase 1 — never by hand-splitting/joining a path string
 * (D-03). Every lazy provider fetches through `client.get()` only (never
 * `client.post()`, never raw `fetch`) and throws `normalizeError(res, op)`
 * on a non-ok response, so a Jenkins fetch failure surfaced through the VFS
 * is always redacted/actionable (Pitfall 5).
 */

import { InMemoryFs } from "just-bash";
import type { JenkinsClient } from "./client.js";
import { normalizeError } from "./errors.js";
import { jobPath, parsePathString } from "./paths.js";

/**
 * v1 nesting-depth limit for the single recursive skeleton fetch (folder ->
 * folder -> multibranch job -> branch is the realistic worst case this
 * covers). Jenkins' `tree=` recursion syntax has no infinite-depth operator
 * — it must be spelled out level-by-level (Pitfall 4) — so this is a
 * documented v1 boundary, not an oversight. A folder-type entry that still
 * exposes a `jobs` field at this depth gets an explicit
 * `.more-below-depth-limit` marker file instead of having its subtree
 * silently dropped (T-02-05).
 */
export const SKELETON_DEPTH = 4;

/** Marker file name registered when a folder's children could not be fetched within `SKELETON_DEPTH` (T-02-05). */
export const MORE_BELOW_DEPTH_LIMIT_MARKER = ".more-below-depth-limit";

/** Jenkins build-permalink aliases surfaced as `builds/<alias>/` directories (D-03a). */
const PERMALINK_ALIASES = [
  "lastBuild",
  "lastSuccessfulBuild",
  "lastFailedBuild",
  "lastCompletedBuild",
] as const;

/** Curated `tree=` projection for a job/folder's `api.json` (D-06, READ-02). */
const JOB_TREE_FIELDS =
  "name,fullName,buildable,url,color," +
  "property[parameterDefinitions[name,type,description,defaultParameterValue[value]]]," +
  "builds[number,url,result,building,timestamp,duration]{0,20}";

/** Curated `tree=` projection for a build's `api.json` (D-06, READ-03). */
const BUILD_TREE_FIELDS =
  "number,result,building,duration,timestamp,url,queueId,actions[causes[shortDescription]]";

/** Curated `tree=` projection for `/queue.json` (D-06, READ-06). */
const QUEUE_TREE_FIELDS =
  "items[id,why,blocked,buildable,stuck,task[name,url],actions[causes[shortDescription]]]";

/** A single recent build number, as returned by the depth-bounded skeleton fetch. */
interface SkeletonBuild {
  number: number;
}

/**
 * One folder/job/branch entry in the recursive skeleton fetch response.
 * `jobs` is present (possibly empty) for folder-shaped entries (plain
 * folders and multibranch project containers); absent for leaf jobs.
 */
interface SkeletonEntry {
  name: string;
  url?: string;
  color?: string;
  _class?: string;
  builds?: SkeletonBuild[];
  jobs?: SkeletonEntry[];
}

interface SkeletonResponse {
  jobs?: SkeletonEntry[];
}

/**
 * Builds the depth-bounded, name-only Jenkins `tree=` query string used for
 * the single skeleton fetch: `depth` levels of nested
 * `jobs[name,url,color,_class,builds[number]{0,20},jobs[...]]`, with the
 * deepest level omitting a further `jobs[...]` sub-selector (Pitfall 4).
 */
function buildSkeletonTreeQuery(depth: number): string {
  const level = "name,url,color,_class,builds[number]{0,20}";
  let inner = level;
  for (let i = 1; i < depth; i++) {
    inner = `${level},jobs[${inner}]`;
  }
  return `jobs[${inner}]`;
}

/** True when a job/branch entry's `_class` indicates a pipeline job (Pitfall 2). */
function isPipelineClass(jobClass: string | undefined): boolean {
  return (
    typeof jobClass === "string" &&
    (jobClass.includes("WorkflowJob") || jobClass.includes("MultiBranch"))
  );
}

/**
 * Resolves a VFS logical segment array to its Jenkins REST job path,
 * exclusively through `jobPath(parsePathString(...))` (the choke point) —
 * never by hand-splitting/joining. Segments never contain a literal `/`
 * (a multibranch branch name containing one is already `%2F`-encoded by
 * Jenkins itself in the skeleton fetch's `name` field, per the D-06/D-07
 * convention established in Phase 1), so joining with `/` and re-parsing
 * round-trips exactly to the original segment array.
 */
function restJobPathFor(segments: string[]): string {
  return `/job/${jobPath(parsePathString(segments.join("/")))}`;
}

/**
 * Registers the lazy `api.json` provider for a single job/folder directory
 * (READ-02). Follows the `client.get()` -> `if (!res.ok) throw
 * normalizeError(...)` -> `res.text()` shape used throughout `whoami.ts`.
 */
function registerJobApiJson(
  fs: InMemoryFs,
  client: JenkinsClient,
  vfsDir: string,
  restPath: string,
): void {
  fs.writeFileLazy(`${vfsDir}/api.json`, async () => {
    const res = await client.get(`${restPath}/api/json?tree=${JOB_TREE_FIELDS}`);
    if (!res.ok) throw normalizeError(res, "jenkins_bash:job-api-json");
    return res.text();
  });
}

/**
 * Registers the lazy content providers for a single build (or permalink
 * alias) directory: `api.json` (READ-03), `log` (READ-04, whole
 * `consoleText`, cached, no `tree=`), and — for pipeline jobs only —
 * `wfapi.json` (READ-05), which returns an explanatory JSON note instead of
 * throwing on a 404 (freestyle-adjacent 404, Pitfall 2) rather than
 * registering the file at all for freestyle jobs.
 */
function registerBuildFiles(
  fs: InMemoryFs,
  client: JenkinsClient,
  buildDir: string,
  buildRestPath: string,
  isPipeline: boolean,
): void {
  fs.writeFileLazy(`${buildDir}/api.json`, async () => {
    const res = await client.get(`${buildRestPath}/api/json?tree=${BUILD_TREE_FIELDS}`);
    if (!res.ok) throw normalizeError(res, "jenkins_bash:build-api-json");
    return res.text();
  });

  fs.writeFileLazy(`${buildDir}/log`, async () => {
    const res = await client.get(`${buildRestPath}/consoleText`);
    if (!res.ok) throw normalizeError(res, "jenkins_bash:console-log");
    return res.text();
  });

  if (isPipeline) {
    fs.writeFileLazy(`${buildDir}/wfapi.json`, async () => {
      const res = await client.get(`${buildRestPath}/wfapi/describe`);
      if (res.status === 404) {
        return JSON.stringify({ _note: "wfapi not available for this job" });
      }
      if (!res.ok) throw normalizeError(res, "jenkins_bash:wfapi");
      return res.text();
    });
  }
}

/**
 * Registers `builds/<n>/` for each recent build number the skeleton fetch
 * returned, plus `builds/<alias>/` for every permalink alias (D-03a) — the
 * exact same lazy-file mechanism as a numbered build, just a different REST
 * path suffix that Jenkins resolves server-side, so no build number needs
 * to be known up front.
 */
function registerBuildsAndPermalinks(
  fs: InMemoryFs,
  client: JenkinsClient,
  jobVfsDir: string,
  restJobPath: string,
  entry: SkeletonEntry,
): void {
  const isPipeline = isPipelineClass(entry._class);
  const buildsDir = `${jobVfsDir}/builds`;

  for (const build of entry.builds ?? []) {
    registerBuildFiles(
      fs,
      client,
      `${buildsDir}/${build.number}`,
      `${restJobPath}/${build.number}`,
      isPipeline,
    );
  }

  for (const alias of PERMALINK_ALIASES) {
    registerBuildFiles(fs, client, `${buildsDir}/${alias}`, `${restJobPath}/${alias}`, isPipeline);
  }
}

/**
 * Recursively walks the skeleton fetch response, materializing one VFS
 * directory (plus its lazy `api.json`/`builds/...` providers) per
 * folder/job/branch entry. `depthRemaining` starts at `SKELETON_DEPTH` and
 * is decremented once per recursion level; when it reaches `1` (this batch
 * of entries is already at the depth limit) and an entry still exposes a
 * non-empty `jobs` field, a `.more-below-depth-limit` marker file is
 * written instead of recursing further (T-02-05, Pitfall 4).
 */
async function walkSkeleton(
  fs: InMemoryFs,
  client: JenkinsClient,
  entries: SkeletonEntry[] | undefined,
  parentSegments: string[],
  parentVfsDir: string,
  depthRemaining: number,
): Promise<void> {
  for (const entry of entries ?? []) {
    const segments = [...parentSegments, entry.name];
    const vfsDir = `${parentVfsDir}/${entry.name}`;
    const restPath = restJobPathFor(segments);

    registerJobApiJson(fs, client, vfsDir, restPath);
    registerBuildsAndPermalinks(fs, client, vfsDir, restPath, entry);

    if (entry.jobs !== undefined) {
      if (depthRemaining > 1) {
        await walkSkeleton(fs, client, entry.jobs, segments, vfsDir, depthRemaining - 1);
      } else if (entry.jobs.length > 0) {
        await fs.writeFile(
          `${vfsDir}/${MORE_BELOW_DEPTH_LIMIT_MARKER}`,
          `This folder has sub-jobs beyond the VFS skeleton depth limit (SKELETON_DEPTH=${SKELETON_DEPTH}) ` +
            "and could not be fetched in this pass.\n",
        );
      }
    }
  }
}

/**
 * Builds a populated, read-write `InMemoryFs` mirroring the connected
 * Jenkins instance: `/jobs/...` directory skeleton (folders, jobs,
 * multibranch branches, recent builds, permalink aliases) plus
 * `/queue.json`, with every file's content fetched lazily on first read
 * (D-04). Issues exactly ONE `client.get()` call during this function's own
 * execution — the depth-bounded, name-only skeleton fetch; every other
 * `client.get()` call happens later, lazily, on first read of a given file
 * (D-09). Callers (the `jenkins_bash` tool handler, plan 02-03) are
 * responsible for wrapping the returned `InMemoryFs` in a read-only
 * `IFileSystem` shim (D-08) before passing it to `just-bash`'s `Bash`
 * constructor.
 */
export async function buildJenkinsVfs(client: JenkinsClient): Promise<InMemoryFs> {
  const treeQuery = buildSkeletonTreeQuery(SKELETON_DEPTH);
  const res = await client.get(`/api/json?tree=${treeQuery}`);
  if (!res.ok) throw normalizeError(res, "jenkins_bash:skeleton");
  const body = (await res.json()) as SkeletonResponse;

  const fs = new InMemoryFs();
  await fs.mkdir("/jobs", { recursive: true });

  await walkSkeleton(fs, client, body.jobs, [], "/jobs", SKELETON_DEPTH);

  fs.writeFileLazy("/queue.json", async () => {
    const queueRes = await client.get(`/queue/api/json?tree=${QUEUE_TREE_FIELDS}`);
    if (!queueRes.ok) throw normalizeError(queueRes, "jenkins_bash:queue");
    return queueRes.text();
  });

  return fs;
}

/**
 * Jenkins-mirroring in-memory virtual filesystem (D-01, D-03).
 *
 * `buildJenkinsVfs(client)` issues a single shallow, name-only Jenkins
 * metadata fetch (`JENKINS_VFS_PREFETCH_DEPTH`, default 1) to materialize the
 * top of the `/jobs/...` directory skeleton (folders, jobs, multibranch
 * branches) plus recent-build and permalink-alias build directories, and
 * `/queue.json` at the root (D-03/D-03b/D-04). Deeper directories are
 * fetched only when first listed, statted, or read — via the
 * `HydratingJenkinsFs` wrapper this function returns (LAZY-HYDRATION). No
 * log, stage, or per-build detail is fetched during either the initial
 * prefetch or a directory hydration — those are registered as `InMemoryFs`
 * lazy file providers (D-04) that fetch a curated Jenkins REST `tree=`
 * projection through the existing `JenkinsClient` on first read only, and
 * are cached for the remainder of the invocation (D-05/D-09).
 *
 * Every VFS-path-to-REST-path translation routes exclusively through
 * `jobPath(parsePathString(...))` from `./paths.js` — the choke point
 * established in Phase 1 — never by hand-splitting/joining a path string
 * (D-03). Every lazy provider and every hydration fetch fetches through
 * `client.get()` only (never `client.post()`, never raw `fetch`) and throws
 * `normalizeError(res, op)` on a non-ok response, so a Jenkins fetch failure
 * surfaced through the VFS is always redacted/actionable (Pitfall 5). Every
 * fetch also carries an `AbortSignal.timeout(fetchTimeoutMs())`
 * (FETCH-TIMEOUT), so a fetch against a very large or slow instance never
 * silently hangs — it throws an actionable `JenkinsError` instead (see
 * `errors.ts`'s TimeoutError branch).
 */

import { InMemoryFs } from "just-bash";
import { logger } from "../logger.js";
import type { JenkinsClient } from "./client.js";
import { normalizeError } from "./errors.js";
import { type HydrateDirOptions, HydratingJenkinsFs } from "./hydrating-fs.js";
import { jobPath, parsePathString } from "./paths.js";

/**
 * Env var name for the initial-prefetch depth (PREFETCH-DEPTH). Read at call
 * time (mirroring `logger.ts`'s `LOG_LEVEL` pattern) so tests can set it
 * without a re-import.
 */
export const JENKINS_VFS_PREFETCH_DEPTH = "JENKINS_VFS_PREFETCH_DEPTH";

/** Default initial-prefetch depth: top level only — everything below hydrates on first access. */
export const DEFAULT_PREFETCH_DEPTH = 1;

/** Env var name for the per-fetch timeout in milliseconds (FETCH-TIMEOUT). */
export const JENKINS_VFS_FETCH_TIMEOUT_MS = "JENKINS_VFS_FETCH_TIMEOUT_MS";

/** Default per-fetch timeout: well under the client's overall 120s budget. */
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Parses `JENKINS_VFS_PREFETCH_DEPTH` as an integer, floors to >= 1, and
 * falls back to `DEFAULT_PREFETCH_DEPTH` when unset/non-numeric. Read at
 * call time (not module load) for testability.
 */
function prefetchDepth(): number {
  const raw = process.env[JENKINS_VFS_PREFETCH_DEPTH];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PREFETCH_DEPTH;
  return Math.max(1, parsed);
}

/**
 * Parses `JENKINS_VFS_FETCH_TIMEOUT_MS` as an integer, using it only when
 * finite and > 0; falls back to `DEFAULT_FETCH_TIMEOUT_MS` otherwise. Read at
 * call time (not module load) for testability.
 *
 * IMPORTANT: this must only ever be called once per `buildJenkinsVfs`
 * invocation, from `buildJenkinsVfs` itself, BEFORE any `bash.exec()` call
 * begins (`../tools/bash.js` always calls `buildJenkinsVfs` first). Calling
 * it lazily from inside a lazy file provider or `hydrateDir` — i.e. while
 * `bash.exec()` is running — trips `just-bash`'s `defenseInDepth` guard
 * (enabled by default), which blocks `process.env` reads during script
 * execution and throws a `SecurityViolationError` instead of the intended
 * fetch. The resolved value is captured once and threaded through via
 * `makeFetchInit` instead.
 */
function fetchTimeoutMs(): number {
  const raw = process.env[JENKINS_VFS_FETCH_TIMEOUT_MS];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FETCH_TIMEOUT_MS;
}

/** A `RequestInit` factory bound to a single, already-resolved timeout value. */
type FetchInit = () => RequestInit;

/**
 * Builds a `FetchInit` factory bound to `timeoutMs`, resolved once by the
 * caller (see `fetchTimeoutMs`'s doc comment for why this must not re-read
 * `process.env` per call). Each invocation still creates a FRESH
 * `AbortSignal.timeout(timeoutMs)` (a signal fires once and cannot be
 * reused), so every `client.get()` call site gets its own independent
 * timeout window.
 */
function makeFetchInit(timeoutMs: number): FetchInit {
  return () => ({ signal: AbortSignal.timeout(timeoutMs) });
}

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

/** A single recent build number, as returned by the skeleton/hydration fetch. */
interface SkeletonBuild {
  number: number;
}

/**
 * One folder/job/branch entry in a skeleton or hydration fetch response.
 * `jobs` is present (possibly empty) for folder-shaped entries (plain
 * folders and multibranch project containers); absent for leaf jobs. A
 * deeper prefetch (or a nested test fixture) may already carry a non-empty
 * `jobs` field even below the top level — `registerLevel` recurses into it
 * when present.
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
 * both the initial prefetch and each per-directory hydration fetch: `depth`
 * levels of nested `jobs[name,url,color,_class,builds[number]{0,20}]`, with
 * the deepest level omitting a further `jobs[...]` sub-selector (Pitfall 4).
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
 * True when a job/branch entry's `_class` indicates a folder-shaped
 * container (plain folder, organization folder, or multibranch project) —
 * used only to prune the ancestor-walk during file reads (a known leaf job
 * has no sub-jobs, so hydrating "above" it again is unnecessary). Belt-and-
 * suspenders: an explicit `readdir`/`readdirWithFileTypes` of a directory
 * still attempts the fetch regardless of this classification (`force:
 * true`), so a misclassified folder type still reveals its children on an
 * explicit `ls`.
 */
function isFolderClass(cls: string | undefined): boolean {
  return typeof cls === "string" && (cls.includes("Folder") || cls.includes("MultiBranch"));
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
  fetchInit: FetchInit,
): void {
  fs.writeFileLazy(`${vfsDir}/api.json`, async () => {
    const res = await client.get(`${restPath}/api/json?tree=${JOB_TREE_FIELDS}`, fetchInit());
    if (!res.ok) throw normalizeError(res, "jenkins_bash:job-api-json");
    return res.text();
  });
}

/** Matches the `<definition class="...">` opening tag in a job's config.xml (best-effort scan, not a full XML parser). */
const DEFINITION_TAG_RE = /<definition\s+class="([^"]*)"/;

/** Matches the `<script>...</script>` body of an inline (CpsFlowDefinition) pipeline definition. */
const SCRIPT_TAG_RE = /<script>([\s\S]*?)<\/script>/;

/** Matches the `<scriptPath>...</scriptPath>` value of an SCM (CpsScmFlowDefinition) pipeline definition. */
const SCRIPT_PATH_TAG_RE = /<scriptPath>([\s\S]*?)<\/scriptPath>/;

/** Strips a `<![CDATA[ ... ]]>` wrapper from an extracted XML text node, if present. */
function stripCdata(text: string): string {
  const trimmed = text.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  return cdataMatch ? (cdataMatch[1] ?? "").trim() : trimmed;
}

/**
 * Derives the `Jenkinsfile` VFS entry content from a job's raw `config.xml`
 * text (D-07a, Pitfall 4). Branches on the `<definition class="...">`
 * attribute — never attempts `<script>` extraction without first checking
 * which definition class is present, since both inline and SCM pipelines
 * produce a `<definition>` element:
 * - `CpsScmFlowDefinition` (SCM-sourced): returns an explicit, non-empty
 *   marker naming the `scriptPath` when present — never a silently
 *   empty/wrong value, since the actual script lives in the SCM repo, not in
 *   config.xml at all.
 * - `CpsFlowDefinition` (inline): extracts and returns the `<script>` body
 *   (CDATA-unwrapped), a best-effort string scan documented as a
 *   convenience, not a full XML parser.
 * - Neither class found (freestyle/non-pipeline job): returns a short
 *   "no inline script" marker.
 */
function deriveJenkinsfileContent(configXml: string): string {
  const definitionClass = DEFINITION_TAG_RE.exec(configXml)?.[1] ?? "";

  if (definitionClass.includes("CpsScmFlowDefinition")) {
    const scriptPath = SCRIPT_PATH_TAG_RE.exec(configXml)?.[1]?.trim() || "unknown";
    return (
      `This pipeline's Jenkinsfile is SCM-sourced (scriptPath: ${scriptPath}) ` +
      "and is not retrievable via the Jenkins REST config.xml endpoint."
    );
  }

  if (definitionClass.includes("CpsFlowDefinition")) {
    const scriptBody = SCRIPT_TAG_RE.exec(configXml)?.[1];
    if (scriptBody !== undefined) return stripCdata(scriptBody);
  }

  return "This job has no inline pipeline script (not a CpsFlowDefinition pipeline).";
}

/**
 * Registers the lazy `config.xml` and `Jenkinsfile` providers for a single
 * job directory (CTRL-05, D-07/D-07a), mirroring `registerJobApiJson`'s
 * fetch/error shape exactly, with two differences: `config.xml` is not a
 * `tree=`-capable endpoint (raw XML, no projection), and a 403 is
 * special-cased with a distinct operation label naming the
 * `Job/ExtendedRead` permission specifically — since modern Jenkins
 * (2.401.3.3+) gates `config.xml` separately from the plain `Job/Read` that
 * already covers every other VFS file in this project (Pitfall 3).
 * `Jenkinsfile` re-fetches (and independently caches, like every other lazy
 * file in this module) the same `config.xml` text, then derives its content
 * via `deriveJenkinsfileContent` (Pitfall 4).
 */
function registerJobConfigXml(
  fs: InMemoryFs,
  client: JenkinsClient,
  vfsDir: string,
  restPath: string,
  fetchInit: FetchInit,
): void {
  const fetchConfigXml = async (): Promise<string> => {
    const res = await client.get(`${restPath}/config.xml`, fetchInit());
    if (res.status === 403) {
      throw normalizeError(res, "jenkins_bash:config-xml (requires Job/ExtendedRead permission)");
    }
    if (!res.ok) throw normalizeError(res, "jenkins_bash:config-xml");
    return res.text();
  };

  fs.writeFileLazy(`${vfsDir}/config.xml`, fetchConfigXml);

  fs.writeFileLazy(`${vfsDir}/Jenkinsfile`, async () => {
    const configXml = await fetchConfigXml();
    return deriveJenkinsfileContent(configXml);
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
  fetchInit: FetchInit,
): void {
  fs.writeFileLazy(`${buildDir}/api.json`, async () => {
    const res = await client.get(
      `${buildRestPath}/api/json?tree=${BUILD_TREE_FIELDS}`,
      fetchInit(),
    );
    if (!res.ok) throw normalizeError(res, "jenkins_bash:build-api-json");
    return res.text();
  });

  fs.writeFileLazy(`${buildDir}/log`, async () => {
    const res = await client.get(`${buildRestPath}/consoleText`, fetchInit());
    if (!res.ok) throw normalizeError(res, "jenkins_bash:console-log");
    return res.text();
  });

  if (isPipeline) {
    fs.writeFileLazy(`${buildDir}/wfapi.json`, async () => {
      const res = await client.get(`${buildRestPath}/wfapi/describe`, fetchInit());
      if (res.status === 404) {
        return JSON.stringify({ _note: "wfapi not available for this job" });
      }
      if (!res.ok) throw normalizeError(res, "jenkins_bash:wfapi");
      return res.text();
    });
  }
}

/**
 * Registers `builds/<n>/` for each recent build number the skeleton/
 * hydration fetch returned, plus `builds/<alias>/` for every permalink alias
 * (D-03a) — the exact same lazy-file mechanism as a numbered build, just a
 * different REST path suffix that Jenkins resolves server-side, so no build
 * number needs to be known up front.
 */
function registerBuildsAndPermalinks(
  fs: InMemoryFs,
  client: JenkinsClient,
  jobVfsDir: string,
  restJobPath: string,
  entry: SkeletonEntry,
  fetchInit: FetchInit,
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
      fetchInit,
    );
  }

  for (const alias of PERMALINK_ALIASES) {
    registerBuildFiles(
      fs,
      client,
      `${buildsDir}/${alias}`,
      `${restJobPath}/${alias}`,
      isPipeline,
      fetchInit,
    );
  }
}

/** Per-directory known-state, populated as entries are registered (folderish drives ancestor-walk pruning during reads). */
type KnownDirs = Map<string, { folderish: boolean }>;

/** Memoized hydration promises, keyed by VFS directory — dedupes concurrent and repeat `hydrateDir` calls for the same dir. */
type HydratedMemo = Map<string, Promise<void>>;

/**
 * Registers one VFS directory (plus its lazy `api.json`/`config.xml`/
 * `builds/...` providers) per entry in `entries`, and records each in
 * `known`. If an entry already carries a non-empty `jobs` field (a deeper
 * prefetch, or a nested test fixture), recurses into it immediately and
 * marks that directory as already hydrated — no marker file is ever
 * written; a folder whose children were not included in this batch's
 * response simply hydrates later, on first access.
 */
function registerLevel(
  fs: InMemoryFs,
  client: JenkinsClient,
  entries: SkeletonEntry[] | undefined,
  parentSegments: string[],
  parentVfsDir: string,
  known: KnownDirs,
  hydratedMemo: HydratedMemo,
  fetchInit: FetchInit,
): void {
  for (const entry of entries ?? []) {
    const segments = [...parentSegments, entry.name];
    const vfsDir = `${parentVfsDir}/${entry.name}`;
    const restPath = restJobPathFor(segments);

    registerJobApiJson(fs, client, vfsDir, restPath, fetchInit);
    registerJobConfigXml(fs, client, vfsDir, restPath, fetchInit);
    registerBuildsAndPermalinks(fs, client, vfsDir, restPath, entry, fetchInit);
    known.set(vfsDir, { folderish: isFolderClass(entry._class) });

    if (entry.jobs !== undefined) {
      registerLevel(fs, client, entry.jobs, segments, vfsDir, known, hydratedMemo, fetchInit);
      hydratedMemo.set(vfsDir, Promise.resolve());
    }
  }
}

/**
 * Builds a populated `HydratingJenkinsFs` mirroring the connected Jenkins
 * instance: `/jobs/...` directory skeleton (folders, jobs, multibranch
 * branches, recent builds, permalink aliases) plus `/queue.json`, with every
 * file's content fetched lazily on first read (D-04), and every directory
 * below the initial prefetch depth (`JENKINS_VFS_PREFETCH_DEPTH`, default 1)
 * hydrated lazily on first list/stat/read (LAZY-HYDRATION). Issues exactly
 * ONE `client.get()` call during this function's own execution — the
 * depth-bounded, name-only prefetch fetch; every other `client.get()` call
 * happens later, lazily, on first access of a given file or directory
 * (D-09). Callers (the `jenkins_bash` tool handler, `../tools/bash.js`) are
 * responsible for wrapping the returned filesystem in a read-only
 * `IFileSystem` shim (D-08) before passing it to `just-bash`'s `Bash`
 * constructor.
 */
export async function buildJenkinsVfs(client: JenkinsClient): Promise<HydratingJenkinsFs> {
  const depth = prefetchDepth();
  // Resolved ONCE here, before any bash.exec() call ever begins (bash.ts
  // always calls buildJenkinsVfs first) — see fetchTimeoutMs's doc comment
  // for why this must not be re-read from inside a lazy provider/hydrateDir.
  const fetchInit = makeFetchInit(fetchTimeoutMs());
  logger.info("jenkins_vfs: prefetching skeleton", { prefetchDepth: depth });
  const t0 = Date.now();

  const treeQuery = buildSkeletonTreeQuery(depth);
  const res = await client.get(`/api/json?tree=${treeQuery}`, fetchInit());
  if (!res.ok) throw normalizeError(res, "jenkins_bash:skeleton");
  const text = await res.text();
  const body = JSON.parse(text) as SkeletonResponse;

  const fs = new InMemoryFs();
  await fs.mkdir("/jobs", { recursive: true });

  const known: KnownDirs = new Map();
  const hydratedMemo: HydratedMemo = new Map();
  known.set("/jobs", { folderish: true });

  registerLevel(fs, client, body.jobs, [], "/jobs", known, hydratedMemo, fetchInit);
  hydratedMemo.set("/jobs", Promise.resolve());

  logger.info("jenkins_vfs: skeleton loaded", {
    bytes: text.length,
    topLevelEntries: body.jobs?.length ?? 0,
    ms: Date.now() - t0,
  });

  fs.writeFileLazy("/queue.json", async () => {
    const queueRes = await client.get(`/queue/api/json?tree=${QUEUE_TREE_FIELDS}`, fetchInit());
    if (!queueRes.ok) throw normalizeError(queueRes, "jenkins_bash:queue");
    return queueRes.text();
  });

  /**
   * Hydrates `vfsDir`'s immediate children on first access, memoized in
   * `hydratedMemo` so concurrent and repeat callers for the same directory
   * share one in-flight (or resolved) promise. Walks ancestors top-down
   * first (a directory can only be fetched once its own REST path is
   * resolvable, which requires its parent to already be known/registered),
   * then decides whether `vfsDir` itself needs a fetch at all before
   * issuing one.
   */
  function hydrateDir(vfsDir: string, opts?: HydrateDirOptions): Promise<void> {
    const cached = hydratedMemo.get(vfsDir);
    if (cached) return cached;

    const promise = (async () => {
      // Ancestor first: vfsDir itself must be registered (known) before we
      // can derive its REST path or decide it's a leaf.
      if (vfsDir !== "/jobs") {
        const parent = vfsDir.slice(0, vfsDir.lastIndexOf("/"));
        if (parent.startsWith("/jobs")) {
          await hydrateDir(parent);
        }
      }

      // Not a hydratable Jenkins-job directory at all: outside /jobs, or a
      // builds/ subtree (already registered when its job was registered).
      if (!vfsDir.startsWith("/jobs") || vfsDir.split("/").includes("builds")) {
        return;
      }

      const meta = known.get(vfsDir);
      // A known leaf job has no sub-jobs — skip fetching unless the caller
      // explicitly forces it (an explicit readdir/readdirWithFileTypes of
      // this exact directory).
      if (meta && meta.folderish === false && !opts?.force) {
        return;
      }

      const segments = vfsDir === "/jobs" ? [] : parsePathString(vfsDir.slice("/jobs".length));
      const restPath = segments.length ? restJobPathFor(segments) : "";

      logger.debug("jenkins_vfs: hydrating dir", { vfsDir });
      const th0 = Date.now();

      const hydrateRes = await client.get(
        `${restPath}/api/json?tree=${buildSkeletonTreeQuery(1)}`,
        fetchInit(),
      );
      if (hydrateRes.status === 404) {
        // Missing/empty listing — let inner produce the proper
        // no-such-file error on the delegated read/list call.
        return;
      }
      if (!hydrateRes.ok) throw normalizeError(hydrateRes, "jenkins_bash:hydrate-dir");

      const hydrateText = await hydrateRes.text();
      const childEntries = (JSON.parse(hydrateText) as SkeletonResponse).jobs ?? [];
      registerLevel(fs, client, childEntries, segments, vfsDir, known, hydratedMemo, fetchInit);

      logger.debug("jenkins_vfs: hydrated dir", {
        vfsDir,
        childCount: childEntries.length,
        bytes: hydrateText.length,
        ms: Date.now() - th0,
      });
    })();

    hydratedMemo.set(vfsDir, promise);
    return promise;
  }

  return new HydratingJenkinsFs(fs, hydrateDir);
}

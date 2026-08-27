/**
 * Shared Jenkins response/data shapes used across the client, operations and
 * formatters.
 *
 * Types only - no runtime logic, no I/O. `Config` is defined in config.ts and
 * imported from there wherever a shared type is needed; it is not redefined
 * here.
 *
 * Wire types (the `Api*` shapes) mirror what Jenkins actually returns and are
 * deliberately optional-heavy: a `tree=` projection returns only the fields
 * asked for, plugins vary by instance, and a field that is absent from the
 * type is invisible to both the compiler and hand-built test fixtures. Assume
 * every field can be missing unless a live response proved otherwise.
 */

/**
 * Identity/permission shape returned by Jenkins' `/me/api/json` endpoint,
 * as surfaced by the `jenkins_whoami` tool.
 *
 * Per RESEARCH.md Assumption A3, `/me/api/json` may not include
 * permission-relevant data - keep permission-related fields optional so a
 * thinner-than-expected response still satisfies this type.
 */
export interface WhoAmI {
  /** Jenkins internal user id (e.g. "jsmith"). */
  id: string;
  /** Human-readable display name, when Jenkins provides one. */
  fullName?: string;
  /** Email address, when Jenkins provides one on the /me response. */
  description?: string | null;
  /**
   * Absolute URL of the user's Jenkins profile page, when present on the
   * /me response.
   */
  absoluteUrl?: string;
  /**
   * Permission-relevant data, if present. Not guaranteed by
   * `/me/api/json` (RESEARCH.md A3) - callers must treat this as optional.
   */
  authorities?: string[];
}

// ---------------------------------------------------------------------------
// Job index wire types (AGNT-02)
// ---------------------------------------------------------------------------

/** One `userRemoteConfigs` entry - the git remote URL a job builds from. */
export interface ApiUserRemoteConfig {
  url?: string;
}

/** The `scm` block of a job, present on jobs whose SCM is git. */
export interface ApiScm {
  userRemoteConfigs?: ApiUserRemoteConfig[];
}

/**
 * One folder/job/branch entry in the nested job-index response. `jobs` is
 * present (possibly empty) for container-shaped entries - plain folders,
 * organization folders, and multibranch projects - and absent for leaf jobs
 * AND for containers that sit at the index depth cap, which is exactly why
 * the cap has to be reported rather than assumed complete.
 */
export interface ApiJobEntry {
  name?: string;
  fullName?: string;
  url?: string;
  color?: string;
  _class?: string;
  scm?: ApiScm;
  jobs?: ApiJobEntry[];
  /** Absent on a folder, and on a job that has never run. */
  lastBuild?: ApiLastBuild | null;
}

/** The `lastBuild` projection carried by each index leaf (Phase 6 criterion 1). */
export interface ApiLastBuild {
  number?: number;
  timestamp?: number;
  result?: string | null;
}

export interface ApiJobsResponse {
  jobs?: ApiJobEntry[];
}

/** How a job behaves, derived from its `_class`. */
export type JobType = "folder" | "multibranch" | "pipeline" | "freestyle" | "other";

/**
 * Last-known build outcome of a job, derived from Jenkins' `color` field
 * (Jenkins encodes status as a ball colour, with an `_anime` suffix while a
 * build is in progress).
 */
export type JobStatus =
  | "success"
  | "unstable"
  | "failed"
  | "aborted"
  | "disabled"
  | "not_built"
  | "building"
  | "unknown";

/** One materialized entry of the job index. */
export interface IndexedJob {
  /** Jenkins fullName, e.g. "team-a/my-service/main". */
  fullName: string;
  type: JobType;
  status: JobStatus;
  url?: string;
  /** Git remote URLs this job builds from, used for git-remote lookup (READ-07). */
  scmUrls: string[];
  /** Depth at which this entry was found, 1 for a top-level job. */
  depth: number;
  /**
   * The job's last build, when it has one. Absent for a folder (which has no
   * builds at all) and for a job that has never run - the two facts a
   * fabricated `#0` would hide. These are the fields that let an agent tell a
   * live job from an abandoned one, which is why criterion 1 names them.
   */
  lastBuild?: IndexedLastBuild;
}

/** One index entry's last build. */
export interface IndexedLastBuild {
  number: number;
  /** Epoch milliseconds, when Jenkins reported one. */
  timestamp?: number;
  /** `null` while the build is still running. */
  result?: string | null;
}

/**
 * The full job index. `droppedFolders` names containers that were NOT
 * expanded because they sit at `depthCap` - reported explicitly so a caller
 * never reads a truncated index as a complete one (AGNT-02).
 */
export interface JobIndex {
  jobs: IndexedJob[];
  total: number;
  depthCap: number;
  droppedFolders: string[];
}

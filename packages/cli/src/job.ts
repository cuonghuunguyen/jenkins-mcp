/**
 * Job resolution: `--job`, then `JENKINS_JOB`, then the git origin remote
 * (ARCH-02).
 *
 * The remote path is what makes `jenkins build` work with no arguments from
 * inside a checkout: the origin URL is matched against the job index's
 * `userRemoteConfigs` URLs, so no naming convention has to be guessed and no
 * per-repo config is needed.
 *
 * Every failure mode - not a git repo, no git, no origin, origin matches
 * nothing, origin matches several jobs - produces one actionable error naming
 * the `--job` escape hatch, rather than a silent wrong answer.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findJobs,
  type JenkinsCache,
  type JenkinsClient,
  JenkinsError,
} from "@cuonghuunguyen/jenkins-core";

const run = promisify(execFile);

/**
 * Reads the origin remote of the git repository containing the cwd. Not a
 * repo, no git installed, and no `origin` remote all collapse to `undefined` -
 * the caller's error message is the same in every case.
 */
export async function gitOriginUrl(): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveJobArgs {
  job?: string;
  /**
   * The origin remote URL, already read by the caller via `gitOriginUrl()`.
   *
   * Passed in rather than read here so this function does no I/O of its own:
   * the git call is the caller's, which keeps the resolution rules directly
   * testable without stubbing a module export.
   */
  remote?: string;
  client: JenkinsClient;
  cache: JenkinsCache;
  depth: number;
}

/** Resolves the job a command should act on. */
export async function resolveJob(args: ResolveJobArgs): Promise<string> {
  const explicit = args.job ?? process.env.JENKINS_JOB?.trim();
  if (explicit) return explicit;

  const remote = args.remote;
  if (remote === undefined || remote === "") {
    throw new JenkinsError(
      "Could not determine the job. Run this from a git checkout with an origin " +
        "remote, set JENKINS_JOB, or pass --job. Use {findJobs} to list jobs.",
      "resolve_job",
      undefined,
      "invalid_input",
    );
  }

  const found = await findJobs(args.client, args.cache, {
    query: remote,
    limit: 5,
    depth: args.depth,
  });

  // findJobs matches fullName substrings too; for remote-based resolution only
  // a real SCM-URL match counts, or a coincidental name match could silently
  // select the wrong job.
  const byRemote = found.matches.filter((job) => job.scmUrls.length > 0);

  if (byRemote.length === 0) {
    throw new JenkinsError(
      `No job on this Jenkins builds the origin remote '${remote}'. Pass --job, or ` +
        "use {findJobs} to search by name.",
      "resolve_job",
      undefined,
      "not_found",
    );
  }

  if (byRemote.length > 1) {
    throw new JenkinsError(
      `${byRemote.length} jobs build the origin remote '${remote}': ` +
        `${byRemote.map((job) => job.fullName).join(", ")}. Pass --job to choose one.`,
      "resolve_job",
      undefined,
      "invalid_input",
    );
  }

  const only = byRemote[0];
  if (only === undefined) {
    throw new JenkinsError(
      `No job on this Jenkins builds the origin remote '${remote}'. Pass --job.`,
      "resolve_job",
      undefined,
      "not_found",
    );
  }
  return only.fullName;
}

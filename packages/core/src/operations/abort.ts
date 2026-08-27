/**
 * Graceful build abort (CTRL-04, D-06).
 *
 * Issues a single crumb-protected POST to `/job/<path>/<build>/stop` - the
 * same behavior as clicking the Jenkins Abort button. Per RESEARCH.md
 * Assumption A1, both a 2xx AND a 302 response are treated as success
 * (Jenkins' `/stop` endpoint commonly redirects back to the build page). Any
 * other status routes through `normalizeError`, so the surfaced message is
 * redacted/actionable and never leaks a token/crumb/cookie value (CONN-03).
 *
 * The write boundary stays at `/stop` only (SAFE-02): this operation never
 * constructs the forceful `/term` or `/kill` escalation endpoints.
 */

import type { JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";
import { isMultibranchJob, loadJobIndex } from "./jobs.js";

/** Arguments accepted by `abortBuild`. */
export interface AbortArgs {
  job: string;
  ref?: string;
  /**
   * Index depth, used only to decide whether a bare-integer `ref` means a PR
   * (REF-01). An agent that has read a PR build all session with `ref: 42`
   * reaches for the emergency stop with the same ref; getting `not_found`
   * there instead of an abort is the sharpest form of this bug.
   */
  depth?: number;
  /** Build number, -1, or a permalink alias (REF-01). */
  build: string | number;
}

export interface AbortResult {
  job: string;
  ref?: string;
  build: string;
}

/**
 * Aborts one build. Invalidates the job's cached entries on success, since the
 * build's status changes the instant the abort lands (AGNT-01).
 *
 * The cache is a required parameter (CTRL-08): when it was optional, a caller
 * that simply forgot it kept serving a cached "building" state for the build
 * it had just stopped.
 */
export async function abortBuild(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: AbortArgs,
): Promise<AbortResult> {
  const build = resolveBuildSelector(args.build);
  const ref =
    args.depth !== undefined && /^\d+$/.test(String(args.ref ?? ""))
      ? normalizeRef(
          args.ref,
          isMultibranchJob(await loadJobIndex(client, cache, args.depth), args.job),
        )
      : args.ref;

  const restPath = `${jobRestPath(args.job, ref)}/${build}/stop`;

  // `redirect: "manual"` is what makes the `302 is success` branch below mean
  // what it says. Under fetch's default `redirect: "follow"` the 302 never
  // reaches us: the status we would see is the REDIRECT TARGET's, so a build
  // page answering 403 (a token without build-read permission, or an auth
  // proxy) would be reported as a failed abort - for a build that was in fact
  // aborted, prompting a retry or a human escalation over a no-op.
  const res = await client.post(restPath, { redirect: "manual" });
  if (!res.ok && res.status !== 302) throw normalizeError(res, "jenkins_abort_build");

  cache.invalidateJob(args.job);
  return { job: args.job, ref, build };
}

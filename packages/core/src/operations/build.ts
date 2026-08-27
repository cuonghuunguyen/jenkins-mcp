/**
 * Single-build read, cached by volatility (AGNT-01, REF-01).
 *
 * Phase 5 delivers the addressing and caching contract only: a build is
 * addressed by `job` + optional `ref` + a build selector (number, `-1`, or a
 * permalink alias), and a FINISHED build is cached permanently while a running
 * one gets 10s. Phase 6 enriches the returned shape with stages, commits and
 * failed tests; the cache and addressing behaviour stay as they are here.
 *
 * The curated `tree=` projection is salvaged from the deleted VFS, which was
 * the only place it existed - `duration`, `timestamp`, `queueId` and the build
 * cause are not fetched anywhere else.
 */

import { buildKey, type JenkinsCache } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath, resolveBuildSelector } from "../paths.js";

/** Curated `tree=` projection for a build's `api.json` (D-06, READ-03). */
export const BUILD_TREE_FIELDS =
  "number,result,building,duration,timestamp,url,queueId,actions[causes[shortDescription]]";

interface ApiCause {
  shortDescription?: string;
}

interface ApiAction {
  causes?: ApiCause[];
}

interface ApiBuild {
  number?: number;
  result?: string | null;
  building?: boolean;
  duration?: number;
  timestamp?: number;
  url?: string;
  queueId?: number;
  actions?: ApiAction[];
}

export interface BuildArgs {
  job: string;
  ref?: string;
  build?: string | number;
}

export interface BuildSummary {
  job: string;
  ref?: string;
  /** The selector as resolved for the URL - a number, or a permalink alias. */
  selector: string;
  number?: number;
  /** SUCCESS / FAILURE / UNSTABLE / ABORTED, or null while still building. */
  result: string | null;
  building: boolean;
  durationMs?: number;
  timestamp?: number;
  url?: string;
  /** First build cause Jenkins reports, e.g. "Started by user jsmith". */
  cause?: string;
}

/** Extracts the first build cause from the `actions` array, if any. */
function firstCause(body: ApiBuild): string | undefined {
  for (const action of body.actions ?? []) {
    for (const cause of action.causes ?? []) {
      if (cause.shortDescription) return cause.shortDescription;
    }
  }
  return undefined;
}

/**
 * Reads one build.
 *
 * The cache tier is decided from the RESULT, not the request: a build that is
 * no longer building can never change, so it is cached for the life of the
 * process and a repeat read issues zero REST requests. A running build gets
 * the 10s volatile tier.
 *
 * A permalink alias is cached under the alias, not the resolved number,
 * because that is what the caller asked for - and `lastBuild` deliberately
 * stays volatile even when it points at a finished build, since a new build
 * would move it.
 */
export async function getBuild(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: BuildArgs,
): Promise<BuildSummary> {
  const selector = resolveBuildSelector(args.build);
  const isNumeric = /^\d+$/.test(selector);

  return cache.fetch(
    buildKey(args.job, args.ref, selector, "summary"),
    async () => {
      const restPath = `${jobRestPath(args.job, args.ref)}/${selector}`;
      const res = await client.get(`${restPath}/api/json?tree=${BUILD_TREE_FIELDS}`);
      if (!res.ok) throw normalizeError(res, "jenkins_build");
      const body = (await res.json()) as ApiBuild;

      return {
        job: args.job,
        ref: args.ref,
        selector,
        number: body.number,
        result: body.result ?? null,
        building: body.building === true,
        durationMs: body.duration,
        timestamp: body.timestamp,
        url: body.url,
        cause: firstCause(body),
      };
    },
    (summary) => (isNumeric && !summary.building ? "permanent" : "volatile"),
  );
}

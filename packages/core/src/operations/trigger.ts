/**
 * Build trigger with parameter validation and queue-item resolution
 * (CTRL-01/CTRL-02/CTRL-07, D-04/D-04a/D-04b).
 *
 * The POST is the last thing this operation does, not the first. Jenkins
 * accepts `buildWithParameters` with a misspelled parameter name and SILENTLY
 * IGNORES it: the build starts, uses the default, and fails much later for a
 * reason that looks nothing like a typo. So the job's declared
 * `parameterDefinitions` are read (and cached at the index tier - they only
 * change when someone edits the job) and the params map is checked against
 * them BEFORE anything is written (CTRL-07).
 *
 * After the POST, the queue item id from the `Location` header is resolved to
 * a real build number via the bounded `pollQueueItem` helper (queue.ts,
 * D-04a). The result is a two-branch discriminated union (D-04b) that makes
 * returning the raw queue id as a build number impossible at the type level
 * (Pitfall 1): a resolved branch with `buildNumber`, or an unresolved `queued`
 * branch that never has one.
 *
 * The `hint` strings this operation used to return were removed: agent-facing
 * next-step prose belongs in the format layer, which knows which surface it is
 * writing for (AGNT-04). Core returns data.
 */

import { type JenkinsCache, jobKey } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { JenkinsError, normalizeError } from "../errors.js";
import { jobRestPath, normalizeRef, resolveBuildSelector } from "../paths.js";
import { isMultibranchJob, loadJobIndex } from "./jobs.js";
import { pollQueueItem } from "./queue.js";
import { type WaitResult, waitForBuild } from "./wait.js";

/** Default bound (in seconds) on the internal queue-resolution poll (D-04a). */
export const DEFAULT_RESOLVE_TIMEOUT_S = 15;

/** `tree=` projection for a job's declared build parameters (CTRL-07). */
export const PARAM_DEFINITION_TREE_FIELDS =
  "property[parameterDefinitions[name,type,defaultParameterValue[value],choices]]";

/** `tree=` projection for the parameters a past build actually ran with. */
export const BUILD_PARAM_TREE_FIELDS = "actions[parameters[name,value]]";

// ---------------------------------------------------------------------------
// Wire shapes (local: core's shared `types.ts` is not ours to extend)
// ---------------------------------------------------------------------------

interface ApiParameterDefinition {
  name?: string;
  type?: string;
  defaultParameterValue?: { value?: unknown } | null;
  choices?: unknown[];
}

interface ApiJobProperties {
  property?: Array<{ parameterDefinitions?: ApiParameterDefinition[] } | null>;
}

interface ApiBuildParameters {
  actions?: Array<{ parameters?: Array<{ name?: string; value?: unknown }> } | null>;
}

// ---------------------------------------------------------------------------
// Returned shapes
// ---------------------------------------------------------------------------

/** One parameter a job declares. */
export interface JobParameterDefinition {
  name: string;
  type?: string;
  /** Stringified default, absent when the job declares none. */
  defaultValue?: string;
  /** Present only for a choice parameter. */
  choices?: string[];
}

/** Arguments accepted by `triggerBuild`. */
export interface TriggerArgs {
  job: string;
  ref?: string;
  /**
   * Index depth, used only to decide whether a bare-integer `ref` means a PR
   * (REF-01). `refSchema` promises the agent that '42' addresses 'PR-42', so
   * every ref-taking operation has to honour it - not just the two that did.
   */
  depth?: number;
  params?: Record<string, string>;
  /** Bound in seconds on the queue-resolution poll. */
  timeout?: number;
  /** Reuse this build's parameters as the base map (CTRL-07). */
  rebuildFrom?: string | number;
  /** Block until the resolved build finishes (CTRL-07). */
  wait?: boolean;
  /** Bound on the `wait` phase; defaults to `DEFAULT_WAIT_TIMEOUT_MS`. */
  waitTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Fields both branches carry about how the parameter map was built. */
interface TriggerParamReport {
  /** Parameters sent with the trigger, after merge and validation. */
  params: Record<string, string>;
  /** Names taken from `rebuildFrom` and not overridden by explicit params. */
  inherited: string[];
  /** Declared parameters with no default that the caller did not supply. */
  missingDefaults: string[];
  /**
   * Names the job declares as a password/secret/credentials parameter. The
   * formatter masks their values: the caller supplied them, so nothing is
   * disclosed that the caller did not have, but CONN-03's "never interpolate
   * a secret" posture applies to the transcript and the scrollback too.
   */
  secretParams: string[];
}

/** Result when the queue item resolved to a real build number within the bound. */
export interface TriggerResolved extends TriggerParamReport {
  job: string;
  ref?: string;
  buildNumber: number;
  building: boolean;
  url: string;
  /** Present only when `wait: true` - the finished (or timed-out) state. */
  waited?: WaitResult;
  /**
   * Set when `wait: true` and the chained wait ITSELF failed. The POST already
   * happened and cannot be undone, so the build number is reported anyway -
   * an agent told only "HTTP 404" would reasonably trigger a second build.
   */
  waitError?: string;
}

/** Result when the bounded wait elapsed before the queue item resolved. */
export interface TriggerQueued extends TriggerParamReport {
  job: string;
  ref?: string;
  queued: true;
  queueId: string;
  why: string | null;
}

/**
 * Discriminated union (D-04b) - the two branches make it impossible at the
 * type level for the raw Location-header queue id to be returned as
 * `buildNumber` (Pitfall 1).
 */
export type TriggerResult = TriggerResolved | TriggerQueued;

const QUEUE_ITEM_LOCATION_RE = /\/queue\/item\/(\d+)\/?$/;

/** Builds the `invalid_input` error every validation failure here raises. */
function invalidInput(message: string): JenkinsError {
  return new JenkinsError(message, "jenkins_trigger_build", undefined, "invalid_input");
}

/**
 * An `invalid_input` raised specifically because a parameter NAME is not
 * declared - as opposed to a value or choice mismatch.
 *
 * The distinction exists so `triggerBuild` can tell the one case where the
 * rejection may be based on stale data (the 60s-cached definitions, read
 * before someone edited the job) apart from the cases where it never is.
 */
class UnknownParameterError extends JenkinsError {
  readonly parameterName: string;
  constructor(message: string, parameterName: string) {
    super(message, "jenkins_trigger_build", undefined, "invalid_input");
    this.parameterName = parameterName;
  }
}

/** Parameter classes whose value is a credential (mirrors `build-detail.ts`). */
const SECRET_PARAMETER_TYPE_RE = /Password|Secret|Credentials/i;

/**
 * Extracts the numeric queue item id from a trigger POST's `Location` header.
 * Throws a `JenkinsError` - never fabricates an id - when the header is
 * missing or does not match the expected `/queue/item/<id>/` shape.
 */
export function extractQueueId(location: string | null): string {
  const match = location ? QUEUE_ITEM_LOCATION_RE.exec(location) : null;
  if (!match?.[1]) {
    throw new JenkinsError(
      "Jenkins did not return a usable queue item Location header after the " +
        "trigger POST - cannot resolve a build number.",
      "jenkins_trigger_build",
      undefined,
      "http_error",
    );
  }
  return match[1];
}

/**
 * Reads the parameters a job declares, cached at the index tier: a job's
 * parameter definitions only change when someone edits the job, so paying for
 * this read once per minute is what makes pre-POST validation free in
 * practice.
 */
export async function loadJobParameters(
  client: JenkinsClient,
  cache: JenkinsCache,
  job: string,
  ref?: string,
): Promise<JobParameterDefinition[]> {
  return cache.fetch(
    jobKey(job, ref, "params"),
    async () => {
      const res = await client.get(
        `${jobRestPath(job, ref)}/api/json?tree=${PARAM_DEFINITION_TREE_FIELDS}`,
      );
      if (!res.ok) throw normalizeError(res, "jenkins_trigger_build:parameters");
      const body = (await res.json()) as ApiJobProperties;

      // `property[]` is heterogeneous - most entries are unrelated job
      // properties carrying no parameterDefinitions at all.
      const out: JobParameterDefinition[] = [];
      for (const property of body.property ?? []) {
        for (const definition of property?.parameterDefinitions ?? []) {
          if (definition.name === undefined) continue;
          const raw = definition.defaultParameterValue?.value;
          out.push({
            name: definition.name,
            type: definition.type,
            defaultValue: raw === undefined || raw === null ? undefined : String(raw),
            choices: Array.isArray(definition.choices)
              ? definition.choices.map((choice) => String(choice))
              : undefined,
          });
        }
      }
      return out;
    },
    "index",
  );
}

/** Reads the parameters one past build ran with, for `rebuild_from`. */
async function readBuildParameters(
  client: JenkinsClient,
  restPath: string,
  build: string | number,
): Promise<Record<string, string>> {
  const selector = resolveBuildSelector(build);
  const res = await client.get(`${restPath}/${selector}/api/json?tree=${BUILD_PARAM_TREE_FIELDS}`);
  if (!res.ok) throw normalizeError(res, "jenkins_trigger_build:rebuild-from");
  const body = (await res.json()) as ApiBuildParameters;

  const out: Record<string, string> = {};
  for (const action of body.actions ?? []) {
    for (const param of action?.parameters ?? []) {
      if (param.name === undefined) continue;
      out[param.name] =
        param.value === undefined || param.value === null ? "" : String(param.value);
    }
  }
  return out;
}

/**
 * Checks the merged params map against the job's declarations, and reports
 * the declared-but-unsupplied parameters that have no default.
 *
 * A parameter with no default that the caller omitted is NOT rejected:
 * Jenkins may still resolve it (a plugin-supplied dynamic default, or an
 * empty string), so refusing would block legitimate triggers. It is reported
 * instead, so the formatter can warn.
 */
export function validateTriggerParams(
  definitions: JobParameterDefinition[],
  params: Record<string, string>,
  inherited: string[] = [],
): string[] {
  const names = Object.keys(params);
  const fromRebuild = new Set(inherited);

  if (definitions.length === 0) {
    if (names.length === 0) return [];
    throw invalidInput(
      `This job declares no build parameters, but ${names.length} were passed ` +
        `(${names.join(", ")}). Trigger it without params, or check the job name.`,
    );
  }

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  for (const name of names) {
    const definition = byName.get(name);
    if (definition === undefined) {
      // Blame the right party. An inherited name came from `rebuild_from`, not
      // from the caller, so "Unknown build parameter 'LEGACY'" accuses them of
      // a typo they never made.
      throw fromRebuild.has(name)
        ? new UnknownParameterError(
            `The build you rebuilt from ran with '${name}', which this job no longer ` +
              `declares. Pass params explicitly, or rebuild from a newer build. ` +
              `This job declares: ${definitions.map((each) => each.name).join(", ")}.`,
            name,
          )
        : new UnknownParameterError(
            `Unknown build parameter '${name}'. This job declares: ` +
              `${definitions.map((each) => each.name).join(", ")}.`,
            name,
          );
    }

    const value = params[name] ?? "";
    if (definition.choices !== undefined && !definition.choices.includes(value)) {
      throw invalidInput(
        `Invalid value '${value}' for choice parameter '${name}'. Allowed: ` +
          `${definition.choices.join(", ")}.`,
      );
    }
  }

  return definitions
    .filter((definition) => definition.defaultValue === undefined && !(definition.name in params))
    .map((definition) => definition.name);
}

/**
 * Validates, POSTs, resolves the queue item to a build number, and optionally
 * waits for that build to finish.
 *
 * Invalidates every cached entry for the job on success: a trigger changes
 * the job's build list and its last-build permalinks immediately, which is
 * exactly the case a time-based TTL would get wrong (AGNT-01).
 */
export async function triggerBuild(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: TriggerArgs,
): Promise<TriggerResult> {
  // `refSchema` promises the agent that a bare number is a PR, so a bare
  // number has to BE one here too. Without this, `ref: "42"` addressed
  // `/job/svc/job/42` (a 404) for trigger, abort and diagnose while resolving
  // to `PR-42` for build and wait - the same input, five tools, two meanings.
  const ref =
    args.depth !== undefined && /^\d+$/.test(String(args.ref ?? ""))
      ? normalizeRef(
          args.ref,
          isMultibranchJob(await loadJobIndex(client, cache, args.depth), args.job),
        )
      : args.ref;

  const restPath = jobRestPath(args.job, ref);

  // An old build can carry a parameter the job has since removed, so the
  // inherited map is validated exactly like an explicit one - silently
  // dropping it would make the "rebuild" a different build.
  const inheritedParams =
    args.rebuildFrom === undefined
      ? {}
      : await readBuildParameters(client, restPath, args.rebuildFrom);
  const explicit = args.params ?? {};
  const params = { ...inheritedParams, ...explicit };
  const inherited = Object.keys(inheritedParams).filter((name) => !(name in explicit));

  let definitions = await loadJobParameters(client, cache, args.job, ref);
  let missingDefaults: string[];
  try {
    missingDefaults = validateTriggerParams(definitions, params, inherited);
  } catch (err) {
    // The definitions are cached for 60s and the ONLY invalidation is a
    // SUCCESSFUL post - which, by definition, never runs for a rejected call.
    // So a caller who adds a parameter to the job and triggers it immediately
    // is told "this job declares: BRANCH" as fact, and has no way to break the
    // loop. Re-read once, but ONLY for an unknown NAME: a value or choice
    // mismatch is never stale in a way a refetch would fix.
    if (!(err instanceof UnknownParameterError)) throw err;
    cache.invalidateKey(jobKey(args.job, ref, "params"));
    definitions = await loadJobParameters(client, cache, args.job, ref);
    missingDefaults = validateTriggerParams(definitions, params, inherited);
  }

  const secretParams = definitions
    .filter((each) => SECRET_PARAMETER_TYPE_RE.test(each.type ?? "") && each.name in params)
    .map((each) => each.name);
  const report = { params, inherited, missingDefaults, secretParams };

  const hasParams = Object.keys(params).length > 0;
  const res = hasParams
    ? await client.post(`${restPath}/buildWithParameters`, {
        body: new URLSearchParams(params),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
    : await client.post(`${restPath}/build`, undefined);

  if (!res.ok) throw normalizeError(res, "jenkins_trigger_build");

  cache.invalidateJob(args.job);

  const queueId = extractQueueId(res.headers.get("Location"));
  const timeoutMs = (args.timeout ?? DEFAULT_RESOLVE_TIMEOUT_S) * 1000;
  const outcome = await pollQueueItem(client, queueId, timeoutMs);

  // A queued item has no build number yet, so there is nothing to wait ON -
  // waiting here would poll `lastBuild`, i.e. somebody else's build.
  if (!outcome.resolved) {
    return { ...report, job: args.job, ref, queued: true, queueId, why: outcome.why };
  }

  const resolved: TriggerResolved = {
    ...report,
    job: args.job,
    ref,
    buildNumber: outcome.buildNumber,
    building: true,
    url: outcome.url,
  };

  if (args.wait !== true) return resolved;

  // The ref is passed through exactly as POSTed (no `depth`) - re-resolving it
  // here could address a different job than the one just triggered.
  //
  // A write that SUCCEEDED must never be reported only as an error. The POST
  // has already started build #N irreversibly; if the very first wait poll
  // 404s (the queue-resolved number not yet readable) or 503s (a restarting
  // instance), letting that throw would hand the agent
  // `error: not_found` with no mention of the build - and the natural recovery
  // from that is to trigger again, i.e. a duplicate deploy.
  try {
    const waited = await waitForBuild(client, cache, {
      job: args.job,
      ref,
      build: outcome.buildNumber,
      timeoutMs: args.waitTimeoutMs,
      signal: args.signal,
    });
    return { ...resolved, building: waited.building, waited };
  } catch (err) {
    return {
      ...resolved,
      waitError: err instanceof JenkinsError ? err.message : "the wait could not be started",
    };
  }
}

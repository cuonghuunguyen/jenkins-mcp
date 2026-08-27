/**
 * Build, trigger and abort formatters (AGNT-03/AGNT-04).
 *
 * These own the `next:` hints that used to be baked into the core operations'
 * return values as `hint` fields. Core returns data; this layer decides what
 * to say about it, and the adapters resolve `{ref}` placeholders to their own
 * command names.
 */

import type { AbortResult } from "../operations/abort.js";
import type { BuildSummary } from "../operations/build.js";
import type { TriggerResult } from "../operations/trigger.js";
import { formatAge, formatDuration, withNext } from "./common.js";
import { formatWaitResult } from "./wait.js";

/** Renders a job/ref pair as the compact address form used in output. */
function address(job: string, ref?: string): string {
  return ref === undefined || ref === "" ? job : `${job} @ ${ref}`;
}

export function formatBuildSummary(data: BuildSummary): string {
  const lines = [
    `build: ${address(data.job, data.ref)} #${data.number ?? data.selector}`,
    `status: ${data.building ? "BUILDING" : (data.result ?? "UNKNOWN")}`,
    `duration: ${formatDuration(data.durationMs)}`,
    `age: ${formatAge(data.timestamp)}`,
  ];
  if (data.cause) lines.push(`cause: ${data.cause}`);
  if (data.url) lines.push(`url: ${data.url}`);

  const hints = data.building
    ? ["{wait} to follow this build to completion", "{log} to read the log so far"]
    : data.result === "SUCCESS"
      ? ["{log} to read the console log"]
      : ["{diagnose} to isolate the failure", "{log} to read the console log"];

  return withNext(lines.join("\n"), hints);
}

/**
 * Lines describing how the parameter map was assembled, shared by both
 * trigger branches. A rebuild that silently inherited a parameter the caller
 * never mentioned is exactly the thing worth stating out loud.
 */
function paramLines(data: TriggerResult): string[] {
  const lines: string[] = [];
  const names = Object.keys(data.params);
  // A password/secret parameter's value is masked even though the CALLER
  // supplied it: nothing is disclosed that the caller did not already have,
  // but CONN-03's "never interpolate a secret" posture holds for the MCP
  // transcript and the shell scrollback this text lands in too.
  const secret = new Set(data.secretParams);
  if (names.length > 0)
    lines.push(
      `params: ${names
        .map((n) => `${n}=${secret.has(n) ? "[redacted]" : data.params[n]}`)
        .join(" ")}`,
    );
  if (data.inherited.length > 0) lines.push(`inherited: ${data.inherited.join(", ")}`);
  if (data.missingDefaults.length > 0) {
    lines.push(
      `warning: not supplied and no default declared: ${data.missingDefaults.join(", ")} — ` +
        "Jenkins may resolve these itself, or the build may fail",
    );
  }
  return lines;
}

export function formatTriggerResult(data: TriggerResult): string {
  if ("queued" in data) {
    const lines = [
      `queued: ${address(data.job, data.ref)}`,
      `queueId: ${data.queueId}`,
      `why: ${data.why ?? "waiting for an executor"}`,
      ...paramLines(data),
    ];
    return withNext(lines.join("\n"), [
      "{queue} to see what the queue is waiting on",
      "{job} to check whether it has started since",
    ]);
  }

  const lines = [
    `started: ${address(data.job, data.ref)} #${data.buildNumber}`,
    `url: ${data.url}`,
    ...paramLines(data),
  ];

  // A waited trigger's useful next step is the WAIT's next step (read the
  // log, diagnose the failure), so that formatter owns the hints outright.
  if (data.waited) return `${lines.join("\n")}\n${formatWaitResult(data.waited)}`;

  // The POST already started the build. If the CHAINED wait then failed, the
  // build number is still the most important thing in this result: an agent
  // told only "HTTP 404" would reasonably trigger a second, duplicate build.
  if (data.waitError !== undefined) {
    lines.push(`warning: the build was started but could not be followed — ${data.waitError}`);
    return withNext(lines.join("\n"), [
      `{wait} on #${data.buildNumber} to try following it again`,
      `{build} #${data.buildNumber} to check its state`,
      "do NOT re-trigger: the build above is already running",
    ]);
  }

  // Phase 7 criterion 2: the next call names the RESOLVED build number, so the
  // agent never has to guess which build the trigger produced.
  return withNext(lines.join("\n"), [
    `{wait} on #${data.buildNumber} to follow this build to completion`,
    `{log} on #${data.buildNumber} to read the log as it runs`,
  ]);
}

export function formatAbortResult(data: AbortResult): string {
  return withNext(`aborted: ${address(data.job, data.ref)} #${data.build}`, [
    "{build} to confirm the build reached ABORTED",
  ]);
}

/**
 * jenkins_diagnose_build MCP tool adapter (D-01/D-02/D-03/D-05).
 *
 * Thin adapter over the pure `diagnoseBuild` extraction function in
 * `../jenkins/diagnose.js` — mirrors `trigger.ts`'s shape exactly. All
 * cascade/`_class`/wfapi logic lives in the extraction module; this file
 * only wires the MCP tool name/description/input schema and wraps the
 * result as a `CallToolResult`. No write/POST call is ever issued here or
 * in the extraction module it delegates to (D-01, read-only).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JenkinsClient } from "../jenkins/client.js";
import { type DiagnoseArgs, diagnoseBuild } from "../jenkins/diagnose.js";

/** MCP tool name (D-01, jenkins_<verb> convention). */
export const DIAGNOSE_TOOL_NAME = "jenkins_diagnose_build";

/** Human-readable description surfaced to the MCP client (MCP-02). */
export const DIAGNOSE_TOOL_DESCRIPTION =
  "Diagnose why a Jenkins build failed, in one read-only call. Takes the job " +
  "path (folder-nested form, e.g. 'team-a/my-job') and an optional build " +
  "number - when omitted, targets the most recent build (lastBuild). For a " +
  "failed PIPELINE build, returns the failed stage/step name(s) plus a " +
  "bounded console-log region (never a raw whole-log dump). Freestyle jobs " +
  "and Jenkins instances without the Pipeline REST API (wfapi) plugin get a " +
  "clear, distinct message with no extraction. A non-failed target (still " +
  "building, queued, or succeeded) reports its true state honestly - it " +
  "never fabricates a failure. Use jenkins_bash afterwards for deeper/wider " +
  "log reads (cat/grep/tail over builds/<n>/log, cat builds/<n>/wfapi.json).";

/**
 * Zod raw shape (bare object, matching `triggerInputSchema`'s convention —
 * not wrapped in zod's object-schema helper).
 */
export const diagnoseInputSchema = {
  path: z.string(),
  build: z.number().optional(),
};

/**
 * Builds the `registerTool` handler bound to a given `JenkinsClient`
 * instance (mirrors `createTriggerHandler`'s shape) - delegates entirely to
 * `diagnoseBuild`, then wraps the result as JSON text.
 */
export function createDiagnoseHandler(
  client: JenkinsClient,
): (args: DiagnoseArgs) => Promise<CallToolResult> {
  return async (args) => {
    const result = await diagnoseBuild(client, args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  };
}

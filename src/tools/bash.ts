/**
 * jenkins_bash MCP tool adapter (D-01/D-02/D-07/D-08/D-09).
 *
 * Builds a fresh, read-only, network-less `just-bash` sandbox over the
 * Jenkins-mirroring VFS on every invocation (`buildJenkinsVfs`, D-09), runs
 * the agent-supplied command, and returns its output capped at ~50KB with a
 * truncation notice when exceeded (D-07). This is the sole read/
 * observability surface for READ-01..06 (D-01) — the tool surface is
 * exactly `jenkins_whoami` + `jenkins_bash` (D-02).
 *
 * Sandbox construction never sets `network` (not even `{}` — per
 * 02-01-SUMMARY, an empty object still registers `curl`) and never sets
 * `fetch`, so no network/host-reaching command exists in the sandbox at all
 * (D-08, A4). The `fs` passed to `Bash` is always the `ReadOnlyJenkinsFs`
 * shim (`../jenkins/readonly-fs.js`), never the raw `InMemoryFs` (D-08).
 *
 * `bash.exec()` is wrapped in try/catch: per 02-01-SUMMARY's confirmed
 * finding, an agent's `>` redirect against the read-only shim still rejects
 * `bash.exec()` itself (even though direct commands like `rm`/`mkdir` are
 * caught internally and become normal `{ stdout, stderr, exitCode: 1 }`
 * results) — without this catch, that specific case would surface as an
 * unhandled rejection to the MCP transport. A `JenkinsError` surfaced this
 * way (from a VFS lazy provider) is re-thrown so it propagates to the MCP
 * framework the same way `whoami.ts` lets one propagate (no local
 * swallowing); any other caught error (the read-only-shim redirect case) is
 * converted into a normal `CallToolResult` instead.
 *
 * Output is stdout+stderr combined (Rule 2 addition beyond the literal
 * `result.stdout`-only sketch in PATTERNS.md): empirical verification
 * against the installed `just-bash` package showed that command-level shell
 * errors — including the read-only-shim's rejection message for `rm`/
 * `mkdir`/etc., and `curl`'s "command not found" — are written to `stderr`,
 * not `stdout`. Returning `stdout` alone would silently hide every such
 * error from the agent (looking like an empty, successful result), which
 * would violate this tool's own D-08 read-only-rejection guarantee being
 * observable. The output cap (D-07) applies to the combined text.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Bash } from "just-bash";
import { z } from "zod";
import type { JenkinsClient } from "../jenkins/client.js";
import { JenkinsError } from "../jenkins/errors.js";
import { ReadOnlyJenkinsFs } from "../jenkins/readonly-fs.js";
import { buildJenkinsVfs } from "../jenkins/vfs.js";

/** MCP tool name (D-02, jenkins_<verb> convention). */
export const BASH_TOOL_NAME = "jenkins_bash";

/** Human-readable description surfaced to the MCP client (MCP-02). */
export const BASH_TOOL_DESCRIPTION =
  "Run a read-only bash command (ls, find, cat, grep, tail, head, jq, ...) " +
  "over an in-memory filesystem mirroring the connected Jenkins instance. " +
  "Layout: /jobs/<folder>/<job>/builds/<n>/api.json (build status), " +
  "/jobs/<folder>/<job>/builds/<n>/log (full console log), " +
  "/jobs/<folder>/<job>/builds/<n>/wfapi.json (pipeline stage view, " +
  "pipeline jobs only), /jobs/<folder>/<job>/api.json (job details + " +
  "recent builds), permalink aliases under builds/ (lastBuild, " +
  "lastSuccessfulBuild, lastFailedBuild, lastCompletedBuild), and " +
  "/queue.json at the root (build queue). The filesystem is strictly " +
  "read-only — no write/mkdir/rm/cp/mv/etc. is ever permitted — and has no " +
  "network access. Directories are materialized on demand as they are " +
  "listed (a whole-tree find/grep -r/ls -R over a very large instance " +
  "walks every folder level and can be slow or hit the per-fetch timeout " +
  "— scope such commands to a specific folder). Command output is capped " +
  "at ~50KB; use grep/tail/head to narrow large results (e.g. console " +
  "logs) rather than reading them whole.";

/** Zod raw shape (bare object, matching whoamiInputSchema's convention). */
export const bashInputSchema = { command: z.string() };

/** Output cap in bytes (D-07; exact value is planner discretion). */
export const CAP_BYTES = 50_000;

/**
 * Caps `text` at `CAP_BYTES` UTF-8 bytes, appending a truncation notice
 * reporting the dropped byte count when exceeded. Returns `text` unchanged
 * (byte-identical) when already within the cap.
 */
export function applyOutputCap(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= CAP_BYTES) return text;
  const droppedBytes = buf.length - CAP_BYTES;
  return (
    `${buf.subarray(0, CAP_BYTES).toString("utf8")}\n` +
    `[truncated ${droppedBytes} bytes — narrow with grep/tail]`
  );
}

/**
 * Combines a bash exec result's `stdout` and `stderr` into one text blob so
 * shell-level error messages (read-only rejections, "command not found",
 * etc. — all written to `stderr` by just-bash's command implementations)
 * are visible to the agent rather than silently dropped.
 */
function combineOutput(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}\n${stderr}`;
}

/**
 * Builds the `registerTool` handler bound to a given `JenkinsClient`
 * instance. Per invocation (D-09): builds a fresh Jenkins-mirroring VFS,
 * wraps it in the read-only shim (D-08), constructs a network-less `Bash`
 * sandbox around it, executes the agent's command, and returns the
 * capped, combined output.
 */
export function createBashHandler(
  client: JenkinsClient,
): (args: { command: string }) => Promise<CallToolResult> {
  return async (args: { command: string }) => {
    const vfs = await buildJenkinsVfs(client);
    const roFs = new ReadOnlyJenkinsFs(vfs);
    const bash = new Bash({ fs: roFs });

    let result: { stdout: string; stderr: string };
    try {
      result = await bash.exec(args.command);
    } catch (err) {
      // A JenkinsError from a VFS lazy provider propagates the same way
      // whoami.ts lets one propagate — no local swallowing.
      if (err instanceof JenkinsError) throw err;
      // Any other exec()-level rejection (the read-only shim's `>`
      // redirect path — see the module doc comment) is converted into a
      // normal CallToolResult rather than an unhandled rejection.
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: applyOutputCap(message) }] };
    }

    return {
      content: [
        { type: "text", text: applyOutputCap(combineOutput(result.stdout, result.stderr)) },
      ],
    };
  };
}

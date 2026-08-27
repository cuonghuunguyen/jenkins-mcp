// Env-only, zod-validated, fail-fast configuration (D-01/D-02).
//
// Connection settings come from process.env ONLY - JENKINS_URL, JENKINS_USER,
// JENKINS_API_TOKEN. There is no config-file or dotenv source (D-01).
//
// validateConfig is a pure function (no process.exit, no I/O) so it can be
// unit-tested directly. loadConfig wraps it with the fail-fast side effect:
// on invalid input, write an actionable, secret-safe message to stderr (never
// interpolating a candidate secret value) and exit non-zero (D-02) - the
// server must never start with an invalid config.
//
// The two tuning knobs are deliberately forgiving: a malformed value falls
// back to its default rather than refusing to start, because neither one can
// make the server incorrect - only slower or shallower.

import { z } from "zod";

/** Default nesting depth for the one-request job index (AGNT-02). */
export const DEFAULT_INDEX_DEPTH = 6;

/**
 * Default per-request timeout. Re-homed from the deleted VFS layer, which
 * held the only timeout in the codebase; it now lives on the client so every
 * operation is bounded rather than only the ones that remembered to pass a
 * signal.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Parses an integer env var, clamping to `min` and falling back to
 * `fallback` when unset, empty, or non-numeric.
 */
function intOrDefault(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

/** Values that explicitly mean "not read-only", so they need no warning. */
const EXPLICIT_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * True when `JENKINS_MCP_READONLY` is `1` or `true` (case-insensitive), false
 * for anything else - including junk. A misspelled value must not throw: a
 * server that refuses to start is a worse failure than one that starts with
 * the write tools registered, and the flag is opt-IN.
 *
 * But it must not fail open SILENTLY. `JENKINS_MCP_READONLY=yes` (or `on`,
 * `y`, `enabled`, `ture`) yields a full write server, the operator sees a
 * normal startup, and the first sign of trouble is an agent triggering a build
 * on an instance that was meant to be read-only. One stderr line turns that
 * into a visible fail-open. stderr, not stdout: stdout is the JSON-RPC channel.
 */
function readonlyFlag(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value !== "" && !EXPLICIT_FALSE.has(value)) {
    console.error(
      "jenkins-mcp: JENKINS_MCP_READONLY is set to an unrecognised value; " +
        "write tools ARE registered. Use 1 or true to enable read-only mode.",
    );
  }
  return false;
}

export const ConfigSchema = z.object({
  jenkinsUrl: z.string().url(),
  jenkinsUser: z.string().min(1),
  jenkinsApiToken: z.string().min(1),
  indexDepth: z.number().int().min(1),
  requestTimeoutMs: z.number().int().min(1),
  /** SAFE-03: unregisters the trigger and abort tools entirely. */
  readonly: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

export type ValidateConfigResult =
  | { success: true; data: Config }
  | { success: false; message: string };

export function validateConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ValidateConfigResult {
  const result = ConfigSchema.safeParse({
    jenkinsUrl: env.JENKINS_URL,
    jenkinsUser: env.JENKINS_USER,
    jenkinsApiToken: env.JENKINS_API_TOKEN,
    indexDepth: intOrDefault(env.JENKINS_INDEX_DEPTH, DEFAULT_INDEX_DEPTH, 1),
    requestTimeoutMs: intOrDefault(env.JENKINS_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1),
    readonly: readonlyFlag(env.JENKINS_MCP_READONLY),
  });

  if (!result.success) {
    // Name only the offending zod field path(s) - never interpolate the
    // candidate value itself, which may be (or contain) the secret token.
    const offendingFields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ].join(", ");
    const message =
      `jenkins-mcp: invalid or missing configuration for: ${offendingFields}. ` +
      "Set JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN in the MCP client's env block.";
    return { success: false, message };
  }

  return { success: true, data: result.data };
}

/**
 * Loads and validates config from the environment. On failure, writes an
 * actionable, secret-safe message to stderr and exits non-zero (D-02):
 * the server must never start with an invalid/missing config.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = validateConfig(env);
  if (!result.success) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
  return result.data;
}

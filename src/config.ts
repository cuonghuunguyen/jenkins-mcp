// Env-only, zod-validated, fail-fast configuration (D-01/D-02).
//
// Connection settings come from process.env ONLY — JENKINS_URL, JENKINS_USER,
// JENKINS_API_TOKEN. There is no config-file or dotenv source in v1 (D-01).
//
// validateConfig is a pure function (no process.exit, no I/O) so it can be
// unit-tested directly. loadConfig wraps it with the fail-fast side effect:
// on invalid input, write an actionable, secret-safe message to stderr (never
// interpolating a candidate secret value) and exit non-zero (D-02) — the
// server must never start with an invalid config.

import { z } from "zod";

export const ConfigSchema = z.object({
  jenkinsUrl: z.string().url(),
  jenkinsUser: z.string().min(1),
  jenkinsApiToken: z.string().min(1),
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
  });

  if (!result.success) {
    // Name only the offending zod field path(s) — never interpolate the
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

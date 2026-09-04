/**
 * Credential resolution for the CLI: flags override environment.
 *
 * Kept separate from core's `loadConfig`, which exits the process on a bad
 * config - correct for a server that must not start half-configured, wrong for
 * a CLI that should print one actionable error line.
 */

import {
  type Config,
  createJenkinsClient,
  JenkinsCache,
  type JenkinsClient,
  JenkinsError,
  validateConfig,
} from "@cuonghuunguyen/jenkins-core";

export interface CredentialFlags {
  url?: string;
  user?: string;
  token?: string;
}

/**
 * Resolves config from flags then environment.
 *
 * Uses `||` rather than `??` deliberately: an exported-but-empty `JENKINS_URL`
 * must fall through to the next source rather than shadowing it with "".
 */
export function resolveConfig(flags: CredentialFlags = {}): Config {
  const result = validateConfig({
    ...process.env,
    JENKINS_URL: flags.url || process.env.JENKINS_URL,
    JENKINS_USER: flags.user || process.env.JENKINS_USER,
    JENKINS_API_TOKEN: flags.token || process.env.JENKINS_API_TOKEN,
  });

  if (!result.success) {
    throw new JenkinsError(
      `${result.message} Or pass --url, --user and --token.`,
      "resolve_config",
      undefined,
      "invalid_input",
    );
  }

  return result.data;
}

export interface Session {
  client: JenkinsClient;
  cache: JenkinsCache;
  config: Config;
}

/**
 * Builds the per-invocation client and cache.
 *
 * A CLI process is short-lived, so the cache only pays off within one command
 * (an operation that reads the index and then a build). That is enough to make
 * the shared core operations behave identically under both adapters.
 */
export function createSession(flags: CredentialFlags = {}): Session {
  const config = resolveConfig(flags);
  return { client: createJenkinsClient(config), cache: new JenkinsCache(), config };
}

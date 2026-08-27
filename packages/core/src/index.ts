/**
 * `@jenkins-mcp/core` public surface.
 *
 * Core knows nothing about MCP or the CLI: no MCP SDK, no yargs, no stdout.
 * An operation takes a client (plus a cache, plus params) and returns
 * structured data or throws; a formatter turns exactly one operation's return
 * type into text. Both adapters import from this barrel only.
 *
 * A new capability is: one operation + one formatter here, then a thin adapter
 * in each of `packages/mcp` and `packages/cli` (ARCH-03).
 */

export { CrumbCache, type CrumbState } from "./auth.js";
export {
  buildKey,
  type CacheTier,
  JenkinsCache,
  jobKey,
  TIER_TTL_MS,
} from "./cache.js";
export { createJenkinsClient, type JenkinsClient } from "./client.js";
export {
  type Config,
  ConfigSchema,
  DEFAULT_INDEX_DEPTH,
  DEFAULT_REQUEST_TIMEOUT_MS,
  loadConfig,
  type ValidateConfigResult,
  validateConfig,
} from "./config.js";
export {
  applyCommandRefs,
  type CommandRef,
  type CommandVocabulary,
  type ErrorCode,
  JenkinsError,
  normalizeError,
  type RedactableHeaders,
  redact,
} from "./errors.js";
export * from "./format/api.js";
export * from "./format/build.js";
export * from "./format/build-detail.js";
export * from "./format/common.js";
export * from "./format/diagnose.js";
export * from "./format/job-detail.js";
export * from "./format/jobs.js";
export * from "./format/log.js";
export * from "./format/queue.js";
export * from "./format/wait.js";
export * from "./format/whoami.js";
export { logger } from "./logger.js";
export * from "./operations/abort.js";
export * from "./operations/api.js";
export * from "./operations/build.js";
export * from "./operations/build-detail.js";
export * from "./operations/definition.js";
export * from "./operations/diagnose.js";
export * from "./operations/job-detail.js";
export * from "./operations/jobs.js";
export * from "./operations/log.js";
export * from "./operations/queue.js";
export * from "./operations/queue-list.js";
export * from "./operations/trigger.js";
export * from "./operations/wait.js";
export * from "./operations/whoami.js";
export {
  encodeSegment,
  jobPath,
  jobRestPath,
  normalizeRef,
  PERMALINK_ALIASES,
  type PermalinkAlias,
  parsePathString,
  resolveBuildSelector,
} from "./paths.js";
export * from "./types.js";

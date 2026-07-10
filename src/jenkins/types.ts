/**
 * Shared Jenkins response/data shapes used across the client and tools.
 *
 * Types only — no runtime logic, no I/O. `Config` is defined in
 * src/config.ts and imported from there wherever a shared type is needed;
 * it is not redefined here.
 */

/**
 * Identity/permission shape returned by Jenkins' `/me/api/json` endpoint,
 * as surfaced by the `jenkins_whoami` tool.
 *
 * Per RESEARCH.md Assumption A3, `/me/api/json` may not include
 * permission-relevant data — keep permission-related fields optional so a
 * thinner-than-expected response still satisfies this type.
 */
export interface WhoAmI {
  /** Jenkins internal user id (e.g. "jsmith"). */
  id: string;
  /** Human-readable display name, when Jenkins provides one. */
  fullName?: string;
  /** Email address, when Jenkins provides one on the /me response. */
  description?: string | null;
  /**
   * Absolute URL of the user's Jenkins profile page, when present on the
   * /me response.
   */
  absoluteUrl?: string;
  /**
   * Permission-relevant data, if present. Not guaranteed by
   * `/me/api/json` (RESEARCH.md A3) — callers must treat this as optional.
   */
  authorities?: string[];
}

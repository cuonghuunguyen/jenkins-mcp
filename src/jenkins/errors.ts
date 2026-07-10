/**
 * Centralized error normalization + secret redaction (CONN-03).
 *
 * This is the single path every client and tool error routes through:
 * `normalizeError()` maps a failed HTTP response (or a thrown
 * network/connection error) to a `JenkinsError` with a clear, actionable
 * message — auth failure, insufficient permissions, or connection failure —
 * built ONLY from the HTTP status and a caller-supplied operation label.
 * It never interpolates a raw `Response`, `Headers`, or thrown error object
 * into the message string (RESEARCH.md Pitfall 4), so a token, crumb, or
 * cookie value can never leak into an error message or log line.
 *
 * `redact()` is a separate, allowlist-based helper for the (rarer) case
 * where a caller wants to log headers alongside an error: it replaces every
 * header value NOT on the known-safe allowlist — including Authorization,
 * Cookie, and any crumb header — with a fixed placeholder. Allowlisting
 * known-safe headers (rather than denylisting known-secret ones) is the
 * safer default: a denylist misses new secret-bearing headers over time.
 */

/** Header names that are known-safe to surface verbatim in logs/messages. */
const SAFE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "date",
  "server",
  "cache-control",
  "connection",
  "expires",
  "x-jenkins",
  "x-jenkins-session",
  "x-instance-identity",
  "x-hudson",
  "x-hudson-theme",
  "x-content-type-options",
  "x-request-id",
]);

/** Fixed placeholder every non-allowlisted header value is replaced with. */
const REDACTED_PLACEHOLDER = "[REDACTED]";

export type RedactableHeaders = Headers | Record<string, string> | Array<[string, string]>;

function toEntries(headers: RedactableHeaders): Array<[string, string]> {
  if (headers instanceof Headers) {
    return Array.from(headers.entries());
  }
  if (Array.isArray(headers)) {
    return headers;
  }
  return Object.entries(headers);
}

/**
 * Returns a copy of `headers` where every value NOT on the known-safe
 * allowlist (matched case-insensitively) — including Authorization, Cookie,
 * and any crumb header — is replaced with a fixed placeholder. Never
 * returns an original secret substring.
 */
export function redact(headers: RedactableHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of toEntries(headers)) {
    result[key] = SAFE_HEADER_ALLOWLIST.has(key.toLowerCase()) ? value : REDACTED_PLACEHOLDER;
  }
  return result;
}

/**
 * A normalized, secret-free Jenkins error. `status` is present when the
 * failure originated from an HTTP response; absent for connection failures
 * (thrown network errors, e.g. a rejected `fetch`). `operation` is the
 * caller-supplied label (e.g. "jenkins_whoami") identifying what was being
 * attempted, for operator-facing clarity.
 */
export class JenkinsError extends Error {
  readonly status?: number;
  readonly operation: string;

  constructor(message: string, operation: string, status?: number) {
    super(message);
    this.name = "JenkinsError";
    this.operation = operation;
    this.status = status;
  }
}

/**
 * Maps a failed Jenkins HTTP response, or a thrown network/connection
 * error, to a `JenkinsError` with a clear, actionable, secret-free message.
 *
 * - 401 -> authentication-failure message (checks JENKINS_USER/JENKINS_API_TOKEN)
 * - 403 -> insufficient-permissions message, distinct from the 401 message
 * - other non-ok status -> a generic actionable message naming the status
 * - anything that isn't a `Response` (a thrown fetch/network error) ->
 *   a connection-failure message
 *
 * The message is built ONLY from `status` + `operation`; the raw
 * `Response`/`Headers`/thrown-error object is never interpolated into it
 * (Pitfall 4) — this is what guarantees redaction cannot be forgotten at an
 * individual call site.
 */
export function normalizeError(resOrErr: Response | unknown, operation: string): JenkinsError {
  if (resOrErr instanceof Response) {
    const status = resOrErr.status;

    if (status === 401) {
      return new JenkinsError(
        `Authentication failed calling Jenkins for "${operation}" (401 Unauthorized). ` +
          "Check that JENKINS_USER and JENKINS_API_TOKEN are set correctly and that the " +
          "API token has not expired or been revoked.",
        operation,
        status,
      );
    }

    if (status === 403) {
      return new JenkinsError(
        `Insufficient permissions calling Jenkins for "${operation}" (403 Forbidden). ` +
          "The authenticated Jenkins user does not have the permission required for " +
          "this action.",
        operation,
        status,
      );
    }

    return new JenkinsError(
      `Jenkins request failed for "${operation}" (HTTP ${status}). ` +
        "Check the Jenkins server's own logs for further detail.",
      operation,
      status,
    );
  }

  // Not a Response: a thrown network/connection error (e.g. a rejected
  // fetch). Deliberately does not interpolate the thrown error's own
  // message, which may echo request details.
  return new JenkinsError(
    `Could not connect to Jenkins for "${operation}". ` +
      "Check that JENKINS_URL is correct and the Jenkins server is reachable.",
    operation,
  );
}

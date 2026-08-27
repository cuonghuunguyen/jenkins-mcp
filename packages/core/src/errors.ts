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

/**
 * Names of the capabilities core can point a caller at, written as `{ref}`
 * placeholders inside messages and `next:` hints.
 *
 * Core must not know whether it is talking to an MCP client or a shell, but it
 * is the only place that knows what the useful next step is. So it writes the
 * advice once with a placeholder, and each adapter resolves the placeholder to
 * its own vocabulary - `{build}` becomes `jenkins_build` for the MCP server
 * and `jenkins build` for the CLI. One string, two audiences.
 *
 * Adding a ref means extending REF_PATTERN below AND both vocabularies
 * (`MCP_VOCABULARY` in the mcp package, `CLI_VOCABULARY` in the cli package),
 * or the literal `{ref}` leaks into user-visible output.
 */
export type CommandRef =
  | "whoami"
  | "findJobs"
  | "job"
  | "build"
  | "log"
  | "queue"
  | "trigger"
  | "abort"
  | "diagnose"
  | "wait";

export type CommandVocabulary = Record<CommandRef, string>;

const REF_PATTERN = /\{(whoami|findJobs|job|build|log|queue|trigger|abort|diagnose|wait)\}/g;

/** Rewrites `{...}` command references using an adapter's vocabulary. */
export function applyCommandRefs(message: string, vocab: CommandVocabulary): string {
  return message.replace(REF_PATTERN, (_match, key: CommandRef) => vocab[key]);
}

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
 * Machine-readable error class, rendered as the `<code>` half of a structured
 * error line (AGNT-05). An agent branches on the code; a human reads the
 * message. Keep this list short and stable - a code is only worth adding when
 * a caller would genuinely act differently on it.
 */
export type ErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "http_error"
  | "timeout"
  | "unreachable"
  | "invalid_input";

/** Maps an HTTP status to its error code. */
function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "http_error";
}

/**
 * A normalized, secret-free Jenkins error. `status` is present when the
 * failure originated from an HTTP response; absent for connection failures
 * (thrown network errors, e.g. a rejected `fetch`). `operation` is the
 * caller-supplied label (e.g. "jenkins_whoami") identifying what was being
 * attempted, for operator-facing clarity. `code` is the machine-readable
 * class (AGNT-05), and `tryHint` is the concrete call a caller should attempt
 * next - both surfaced by `formatErrorLine` in the format layer.
 */
export class JenkinsError extends Error {
  readonly status?: number;
  readonly operation: string;
  readonly code: ErrorCode;
  readonly tryHint?: string;

  constructor(
    message: string,
    operation: string,
    status?: number,
    code?: ErrorCode,
    tryHint?: string,
  ) {
    super(message);
    this.name = "JenkinsError";
    this.operation = operation;
    this.status = status;
    this.code = code ?? (status === undefined ? "unreachable" : codeForStatus(status));
    this.tryHint = tryHint;
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

  // A fired AbortSignal.timeout() (or an otherwise-aborted signal) throws a
  // DOMException/error named "TimeoutError" or "AbortError". Detect via a
  // typeof-safe guard so a plain thrown value still falls through to the
  // connection-failure branch below. The message is built ONLY from
  // `operation` + constant text — the thrown value's own `.message` is
  // deliberately never interpolated (Pitfall 4).
  if (
    typeof resOrErr === "object" &&
    resOrErr !== null &&
    "name" in resOrErr &&
    typeof (resOrErr as { name: unknown }).name === "string" &&
    ((resOrErr as { name: string }).name === "TimeoutError" ||
      (resOrErr as { name: string }).name === "AbortError")
  ) {
    return new JenkinsError(
      `Timed out contacting Jenkins for "${operation}". ` +
        "The instance may be very large or slow - raise JENKINS_REQUEST_TIMEOUT_MS, " +
        "lower JENKINS_INDEX_DEPTH, or narrow the request to a specific job.",
      operation,
      undefined,
      "timeout",
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

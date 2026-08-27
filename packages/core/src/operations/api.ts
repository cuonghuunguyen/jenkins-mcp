/**
 * GET-only raw-path escape hatch (READ-12).
 *
 * The deliberate way out when a typed tool does not cover an endpoint. It is
 * also the one operation where a careless implementation turns a read-only
 * server into an SSRF vector, because the client it calls carries an
 * `Authorization` header: an absolute URL in `path` would send that header to
 * a host of the caller's choosing. Hence the validation below is part of the
 * contract, not a convenience.
 *
 * Deliberately NOT cached: the key would be a caller-supplied arbitrary path,
 * i.e. unbounded memory growth for no hit rate.
 */

import type { JenkinsClient } from "../client.js";
import { JenkinsError, normalizeError } from "../errors.js";

/** Default body budget. 64 KiB is roughly the largest useful `config.xml`. */
export const API_GET_MAX_BYTES = 64 * 1024;

export interface ApiGetResult {
  /** The path actually requested, including the `tree=` query when one was given. */
  path: string;
  contentType: string;
  /** Raw response text. Never parsed - the endpoint may return XML or plain text. */
  body: string;
  bytes: number;
  /** True when `bytes` exceeds `maxBytes`, so `--json` callers see the cap too. */
  truncated: boolean;
  /** Byte budget the formatter caps the body at. */
  maxBytes: number;
}

/** Matches `scheme://` and the protocol-relative `//host` form. */
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * Matches a path whose last routed segment is an unprojected API endpoint.
 * `xml` and `python` return the same whole object graph `json` does.
 */
const API_PATH = /\/api\/(json|xml|python)$/;

function invalid(message: string, tryHint: string): JenkinsError {
  return new JenkinsError(message, "jenkins_api_get", undefined, "invalid_input", tryHint);
}

/**
 * The path `fetch` will actually put on the wire.
 *
 * The WHATWG URL parser resolves dot segments - including percent-encoded ones
 * - when the request URL is built, so validating the raw string validates a
 * path that is not the one Jenkins receives. Everything below therefore
 * inspects this form, and this form is what gets sent.
 */
function canonicalPath(path: string): string {
  return new URL(path, "http://jenkins.invalid").pathname;
}

/**
 * The path a servlet container routes on: `;jsessionid=...`-style path
 * parameters stripped and repeated slashes compacted, both of which Jetty does
 * before Stapler ever sees the request. Used only for the mandatory-projection
 * rule, so `/queue/api//json` and `/queue/api/json;x=y` cannot smuggle an
 * unprojected read past it.
 */
function routedPath(canonical: string): string {
  const segments = canonical
    .split("/")
    .map((segment) => segment.split(";")[0] ?? "")
    .filter((segment) => segment !== "");
  return `/${segments.join("/")}`;
}

/** True when a segment is a dot segment in any encoding (`.`, `%2e`, `%2E%2e`). */
function isDotSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape cannot be a dot segment; fall through to the raw form.
  }
  return decoded === "." || decoded === "..";
}

/**
 * Rejects everything that could redirect the authenticated client, escape the
 * instance, or bypass the mandatory-`tree` rule. Order matters: the absolute
 * URL check runs first because `//evil.example/x` also starts with `/`.
 */
function validatePath(path: string, tree: string | undefined): string {
  if (ABSOLUTE_URL.test(path)) {
    throw invalid(
      "path must be a path on the configured Jenkins instance, not an absolute or " +
        "protocol-relative URL. An absolute URL would send the Jenkins credentials to " +
        "another host.",
      "a path beginning with '/', e.g. '/queue/api/json?tree=...' as path='/queue/api/json' plus tree",
    );
  }

  if (!path.startsWith("/")) {
    throw invalid("path must start with '/'.", `path='/${path}' instead of path='${path}'`);
  }

  // Checked on the raw string: a '#' would otherwise be swallowed as a URL
  // fragment and silently truncate the path that is sent.
  const cut = path.search(/[?#]/);
  if (cut !== -1) {
    throw invalid(
      "path must not contain a query string or fragment; tree is the only supported query parameter.",
      `path='${path.slice(0, cut)}' with the projection passed as tree instead`,
    );
  }

  // Dot segments are rejected rather than resolved. Resolving them would let
  // '/job/a/../../etc/passwd' through as '/etc/passwd', which is exactly the
  // escape the rule exists to stop; percent-encoded forms count, because the
  // URL parser applies them too.
  if (path.split("/").some(isDotSegment)) {
    throw invalid(
      "path must not contain a '.' or '..' segment, in any encoding.",
      "the fully-resolved path, with no dot segments",
    );
  }

  const canonical = canonicalPath(path);

  if (API_PATH.test(routedPath(canonical)) && (tree === undefined || tree.trim() === "")) {
    throw invalid(
      "tree is required for an api/json path. An unprojected api/json returns the whole " +
        "object graph, which on a real instance is megabytes.",
      `path='${path}' with tree='jobs[fullName,color]' - name only the fields you need`,
    );
  }

  return canonical;
}

/**
 * GETs an arbitrary Jenkins path. Uses `client.get` and nothing else, so this
 * tool can never become a write vector.
 */
export async function apiGet(
  client: JenkinsClient,
  args: { path: string; tree?: string; maxBytes?: number },
): Promise<ApiGetResult> {
  // The canonicalized form is what is sent, so the request that leaves the
  // process is byte-for-byte the one that was validated.
  const safePath = validatePath(args.path, args.tree);

  // Encoded rather than interpolated raw: a `tree` value containing '&' would
  // otherwise append query parameters of the caller's choosing.
  const query = args.tree === undefined ? "" : `?tree=${encodeURIComponent(args.tree)}`;
  const path = `${safePath}${query}`;

  const res = await client.get(path);
  if (!res.ok) throw normalizeError(res, "jenkins_api_get");

  const body = await res.text();
  const bytes = Buffer.byteLength(body, "utf8");
  const maxBytes = args.maxBytes ?? API_GET_MAX_BYTES;

  return {
    path,
    contentType: res.headers.get("content-type") ?? "unknown",
    body,
    bytes,
    truncated: bytes > maxBytes,
    maxBytes,
  };
}

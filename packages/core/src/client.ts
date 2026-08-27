/**
 * JenkinsClient — Basic auth + CSRF crumb/session attach, with a bounded
 * one-retry-on-403 write contract (CONN-01, CONN-02, D-03).
 *
 * One `CrumbCache` instance is held for the lifetime of the client, so the
 * crumb-fetch and every write share the exact session that issued the
 * crumb (RESEARCH.md Pattern 4). `get()` attaches `Authorization` (and the
 * session cookie, when one is already held) but never requires a crumb to
 * succeed. `post()` attaches `Authorization` plus the crumb header and
 * cookie when a crumb is held; on a crumb-specific 403 it invalidates the
 * cache, re-fetches once, and retries the write exactly once — never a
 * loop (D-03). When the crumb issuer is unavailable (`CrumbCache` returns
 * `null`), `post()` still sends with token+cookie only and never throws
 * pre-flight (D-03 tolerance).
 *
 * A thrown connection error from the underlying Jenkins fetch itself (not
 * the internal crumb-fetch, which `CrumbCache` already tolerates) is
 * normalized via `normalizeError()` so a raw error object is never
 * surfaced to a caller (CONN-03, RESEARCH.md Pitfall 4).
 */

import { CrumbCache } from "./auth.js";
import { type Config, DEFAULT_REQUEST_TIMEOUT_MS } from "./config.js";
import { normalizeError } from "./errors.js";

export interface JenkinsClient {
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, init?: RequestInit): Promise<Response>;
  /** Base URL of the connected instance, for building absolute links in output. */
  readonly baseUrl: string;
}

class JenkinsClientImpl implements JenkinsClient {
  readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly crumbCache = new CrumbCache();

  constructor(config: Config) {
    this.baseUrl = config.jenkinsUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(
      `${config.jenkinsUser}:${config.jenkinsApiToken}`,
    ).toString("base64")}`;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Every request is bounded here rather than at the call sites, so no
   * operation can hang indefinitely. A caller that supplies its own signal
   * (a long poll with its own deadline) keeps it; a fresh
   * `AbortSignal.timeout` is created per request otherwise, since a signal
   * fires once and cannot be reused.
   */
  private signalFor(init?: RequestInit): AbortSignal {
    return init?.signal ?? AbortSignal.timeout(this.timeoutMs);
  }

  /**
   * Builds the operation label used in a connection-failure message.
   *
   * The query string is dropped: a `tree=` projection is hundreds of
   * characters of field names that tell a reader nothing about what failed,
   * and it buried the actionable half of the message. The path itself is kept,
   * since knowing which endpoint was unreachable is the whole point.
   */
  private static operationLabel(path: string): string {
    const queryStart = path.indexOf("?");
    return queryStart === -1 ? path : path.slice(0, queryStart);
  }

  async get(path: string, init?: RequestInit): Promise<Response> {
    const crumb = await this.crumbCache.get(this.baseUrl, this.authHeader);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", this.authHeader);
    if (crumb?.cookie) headers.set("Cookie", crumb.cookie);

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        method: "GET",
        headers,
        signal: this.signalFor(init),
      });
    } catch (err) {
      throw normalizeError(err, JenkinsClientImpl.operationLabel(path));
    }
  }

  async post(path: string, init?: RequestInit, retried = false): Promise<Response> {
    const crumb = await this.crumbCache.get(this.baseUrl, this.authHeader);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", this.authHeader);
    if (crumb) {
      headers.set(crumb.field, crumb.value);
      if (crumb.cookie) headers.set("Cookie", crumb.cookie);
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        method: "POST",
        headers,
        signal: this.signalFor(init),
      });
    } catch (err) {
      throw normalizeError(err, JenkinsClientImpl.operationLabel(path));
    }

    if (res.status === 403 && !retried) {
      const bodyText = await res.clone().text();
      if (/crumb/i.test(bodyText)) {
        // Re-fetch the crumb once and retry the write exactly once — never
        // a loop (D-03). A persistent 403 (retried=true) is returned as-is.
        this.crumbCache.invalidate();
        return this.post(path, init, true);
      }
    }

    return res;
  }
}

export function createJenkinsClient(config: Config): JenkinsClient {
  return new JenkinsClientImpl(config);
}

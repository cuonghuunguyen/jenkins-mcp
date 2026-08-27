/**
 * CrumbCache — lazy CSRF crumb fetch + session-cookie capture (CONN-02, D-03).
 *
 * `get()` fetches `/crumbIssuer/api/json` on first call, capturing the
 * paired session cookie via `headers.getSetCookie()` (NOT
 * `headers.get('set-cookie')`, which unsafely comma-joins multiple
 * `Set-Cookie` headers into one unsplittable string) so the crumb-fetch and
 * a subsequent write can share the exact session that issued the crumb
 * (RESEARCH.md Pitfall 2). The result is cached until `invalidate()` is
 * called — e.g. after a crumb-specific 403 (D-03).
 *
 * A disabled or unreachable crumb issuer (non-ok response, or a thrown
 * network error) is tolerated: `get()` returns `null` rather than throwing,
 * so the caller can fall back to token+session auth alone (D-03).
 */

export interface CrumbState {
  /** The header name Jenkins expects the crumb value under (crumbRequestField). */
  field: string;
  /** The crumb value itself. */
  value: string;
  /** "name=value; name2=value2" rebuilt from getSetCookie(), or null if none were set. */
  cookie: string | null;
}

interface CrumbIssuerBody {
  crumbRequestField: string;
  crumb: string;
}

export class CrumbCache {
  private cached?: CrumbState;

  /**
   * Returns the cached crumb, or lazily fetches and caches one from
   * `${baseUrl}/crumbIssuer/api/json`. Returns `null` (never throws) when
   * the issuer is disabled/unreachable (non-ok response) or fetch itself
   * rejects (network error) — both tolerated per D-03.
   */
  async get(baseUrl: string, authHeader: string): Promise<CrumbState | null> {
    if (this.cached) return this.cached;

    try {
      const res = await fetch(`${baseUrl}/crumbIssuer/api/json`, {
        headers: { Authorization: authHeader },
      });
      if (!res.ok) return null;

      const body = (await res.json()) as CrumbIssuerBody;

      // Node >=19 / undici: getSetCookie() returns each raw Set-Cookie
      // header untouched, unlike headers.get('set-cookie') which
      // comma-joins them unsafely (a cookie's own Expires field contains
      // commas, so a naive join is unsplittable).
      const rawCookies = res.headers.getSetCookie?.() ?? [];
      const cookie =
        rawCookies.length > 0 ? rawCookies.map((raw) => raw.split(";")[0]).join("; ") : null;

      this.cached = { field: body.crumbRequestField, value: body.crumb, cookie };
      return this.cached;
    } catch {
      return null; // network failure -> tolerate, fall back to token-only auth (D-03)
    }
  }

  /** Clears the cached crumb so the next get() re-fetches. */
  invalidate(): void {
    this.cached = undefined;
  }
}

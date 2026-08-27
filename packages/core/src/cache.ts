/**
 * Process-wide, volatility-tiered response cache (AGNT-01).
 *
 * Jenkins data splits cleanly by mutability: a finished build's status,
 * stages, log and test report can never change, so they are cached for the
 * life of the process; the job index changes only when someone edits Jenkins,
 * so it gets 60s; a running build and the queue change continuously, so they
 * get 10s. Trigger and abort invalidate the affected job explicitly, because
 * they are the one thing that can make a cached answer wrong immediately.
 *
 * The tier is chosen from the LOADED VALUE, not from the key, because whether
 * a build is cacheable-forever is only knowable after reading it
 * (`building: false`). That is why `fetch` takes a tier resolver, not a tier.
 *
 * Keys must be built with `jobKey`/`buildKey` so `invalidateJob` can find
 * every entry belonging to one job by prefix.
 */

/** Cache lifetimes by volatility class. */
export type CacheTier = "permanent" | "index" | "volatile";

export const TIER_TTL_MS: Record<CacheTier, number> = {
  permanent: Number.POSITIVE_INFINITY,
  index: 60_000,
  volatile: 10_000,
};

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** Builds a cache key scoped to a job, so `invalidateJob` can prefix-match it. */
export function jobKey(job: string, ref: string | undefined, suffix: string): string {
  return `job:${job} ref:${ref ?? ""} ${suffix}`;
}

/** Builds a cache key for one build of one job/ref. */
export function buildKey(
  job: string,
  ref: string | undefined,
  build: string | number,
  suffix: string,
): string {
  return jobKey(job, ref, `build:${build} ${suffix}`);
}

export class JenkinsCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Counts loader invocations - i.e. real REST round trips (asserted by tests). */
  private loads = 0;

  /**
   * Returns the cached value for `key`, or runs `loader` and caches its
   * result under the tier `tierOf` picks for that result.
   *
   * In-flight requests are NOT deduped: a cache entry is only written once
   * the loader resolves, so two concurrent misses for the same key both
   * fetch. That is acceptable here (an agent calls tools serially) and avoids
   * caching a rejected promise, which would poison the key.
   *
   * ponytail: no in-flight dedupe, add a pending-promise map if concurrent
   * duplicate reads ever show up in practice.
   */
  async fetch<T>(
    key: string,
    loader: () => Promise<T>,
    tierOf: CacheTier | ((value: T) => CacheTier),
  ): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > Date.now()) {
      return hit.value as T;
    }

    this.loads += 1;
    const value = await loader();
    const tier = typeof tierOf === "function" ? tierOf(value) : tierOf;
    const ttl = TIER_TTL_MS[tier];
    this.entries.set(key, {
      value,
      expiresAt: ttl === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttl,
    });
    return value;
  }

  /**
   * Drops every entry belonging to `job` (all refs, all builds). Called by
   * trigger and abort, the only operations that can invalidate a cached
   * answer the instant they succeed.
   */
  invalidateJob(job: string): void {
    const prefix = `job:${job} `;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /**
   * Drops every entry belonging to ONE build of one job/ref.
   *
   * `waitForBuild` is advertised as read-only, so it must not use
   * `invalidateJob`: that prefix-deletes every ref and every build of the job,
   * including `permanent` entries for finished builds and the trigger
   * parameter cache. Waiting on `PR-42` has no business discarding `main`.
   * The job-level permalink entries a finish DOES change (`lastBuild` and
   * friends) sit on the 10s volatile tier and expire on their own.
   */
  invalidateBuild(job: string, ref: string | undefined, build: string | number): void {
    const prefix = jobKey(job, ref, `build:${build} `);
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Drops one exact key. */
  invalidateKey(key: string): void {
    this.entries.delete(key);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  /** Number of loader invocations so far - the REST-request count tests assert on. */
  loadCount(): number {
    return this.loads;
  }

  size(): number {
    return this.entries.size;
  }
}

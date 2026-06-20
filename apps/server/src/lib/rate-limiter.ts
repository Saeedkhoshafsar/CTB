/**
 * Per-token rate limiter (PD-T3) — an in-memory sliding-window counter that caps
 * how many `/api/v1/*` requests a single bearer token may make per 60 seconds.
 *
 * Why in-memory: CTB runs as a single Node process (one engine, one SQLite file
 * — see ARCHITECTURE.md), so a process-local counter is the right scope and the
 * cheapest correct option; there's no second replica to coordinate with. A
 * restart resets the windows, which is acceptable for an abuse guard (it can
 * never *under*-count within a window, only forget across a restart).
 *
 * Algorithm: a true sliding window of request timestamps per key. On each hit we
 * drop timestamps older than the window, then admit iff the survivors are fewer
 * than the limit. `0` = unlimited (the limiter is a no-op for that key). This is
 * O(hits-in-window) per call and self-pruning, so memory stays bounded by the
 * active token set × their limits.
 */

/** The verdict for one admission check. */
export interface RateVerdict {
  allowed: boolean;
  /** Requests still available in the current window (after this hit). */
  remaining: number;
  /** Seconds until the window frees up enough for one more request (≥1). */
  retryAfterSec: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  /** key → ascending request timestamps (ms) still inside the window. */
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /**
   * Try to admit one request for `key` under `limit` requests/window.
   * `limit <= 0` means unlimited — always allowed. A successful check RECORDS
   * the hit; a rejected one does not (so a blocked caller doesn't push its own
   * recovery further out).
   */
  check(key: string, limit: number): RateVerdict {
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0 };
    }
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= limit) {
      // Oldest in-window hit expires first; that's when a slot frees up.
      const oldest = recent[0]!;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      this.hits.set(key, recent); // keep the pruned list
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: limit - recent.length, retryAfterSec: 0 };
  }

  /** Forget a key's window (e.g. when its token is revoked). */
  forget(key: string): void {
    this.hits.delete(key);
  }

  /** Drop all windows. Mostly for tests. */
  reset(): void {
    this.hits.clear();
  }
}

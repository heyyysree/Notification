// ─────────────────────────────────────────────────────────────
// Sliding-window connection rate limiter
//
// Applied on WebSocket upgrade requests to prevent connection
// spam from a single IP — e.g., a client reconnect-looping on
// a bad token, or a misconfigured load tester.
//
// Why sliding window vs fixed window?
// A fixed window counter resets at a hard boundary (e.g., every
// 60 seconds on the clock). A client can exhaust the limit at
// the end of window N and again at the start of window N+1,
// effectively doubling the allowed burst over any real 60s span.
//
// A sliding window tracks actual timestamps: for each incoming
// request it removes timestamps older than `windowMs`, counts
// what remains, and rejects if count ≥ maxConnections. The
// effective rate is always bound to the true window duration.
//
// Phase 1 — in-memory, single-node:
//   Simple. Zero Redis round-trips on the upgrade hot path.
//   Doesn't aggregate across multiple gateway instances; each
//   node applies the limit independently.
//
// Phase 2 — Redis-backed, multi-node:
//   Replace isAllowed() with a Lua script that atomically does:
//     ZADD key NOW timestamp
//     ZREMRANGEBYSCORE key -inf (NOW - windowMs)
//     count = ZCARD key
//     EXPIRE key windowMs
//     return count <= maxConnections
//   This enforces the limit across the full fleet.
// ─────────────────────────────────────────────────────────────

export class ConnectionRateLimiter {
  // ip → sorted array of connection timestamps within the window
  private readonly windows = new Map<string, number[]>()
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly maxConnections: number = 20,
    private readonly windowMs:       number = 60_000,
  ) {
    // Periodic cleanup prevents unbounded Map growth for IPs that
    // connect once and never reconnect within the cleanup interval.
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs * 2)
    this.cleanupTimer.unref()
  }

  /**
   * Returns true if the connection should be allowed and records
   * the attempt. Returns false if the IP has exceeded its limit.
   *
   * Must be called at most once per upgrade attempt — calling it
   * records the attempt regardless of whether it is allowed (we
   * only record ALLOWED attempts; rejected ones are not recorded).
   */
  isAllowed(ip: string): boolean {
    const now    = Date.now()
    const cutoff = now - this.windowMs

    const timestamps = this.windows.get(ip) ?? []

    // Slide: remove entries outside the window
    const inWindow = timestamps.filter(ts => ts > cutoff)

    if (inWindow.length >= this.maxConnections) {
      // Update with pruned list but don't record the rejected attempt
      this.windows.set(ip, inWindow)
      return false
    }

    // Record and allow
    inWindow.push(now)
    this.windows.set(ip, inWindow)
    return true
  }

  /**
   * Remove entries for IPs with no recent activity.
   * Called automatically on the cleanup interval; also exported
   * for tests that want deterministic cleanup.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs
    for (const [ip, timestamps] of this.windows) {
      const inWindow = timestamps.filter(ts => ts > cutoff)
      if (inWindow.length === 0) {
        this.windows.delete(ip)
      } else {
        this.windows.set(ip, inWindow)
      }
    }
  }

  /** Stop the background cleanup timer. Call on graceful shutdown. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}

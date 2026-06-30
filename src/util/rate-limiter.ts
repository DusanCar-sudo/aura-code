/**
 * Token-bucket rate limiter. Each bucket starts full and refills at a
 * steady rate. `acquire()` waits until a token is available, then consumes
 * one. Pass `consume(n)` to take multiple tokens at once (used by TPM).
 */
export interface RateLimiterOptions {
  /** Maximum tokens in the bucket (burst size). */
  capacity: number;
  /** Tokens added per millisecond. e.g. 50 rpm → 50/60000 ≈ 0.000833 */
  refillPerMs: number;
  /** Initial tokens (defaults to capacity). */
  initialTokens?: number;
  /** Sleep function for testing. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when acquire must wait — useful for observability. */
  onWait?: (info: { needed: number; waitMs: number }) => void;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWait?: (info: { needed: number; waitMs: number }) => void;

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerMs;
    this.tokens = opts.initialTokens ?? opts.capacity;
    this.lastRefill = Date.now();
    this.sleep = opts.sleep ?? defaultSleep;
    this.onWait = opts.onWait;
  }

  /**
   * Wait until `n` tokens are available, then consume them.
   * Returns the milliseconds waited (0 if instant).
   */
  async acquire(n = 1): Promise<number> {
    if (n > this.capacity) {
      throw new Error(`Cannot acquire ${n} tokens — bucket capacity is ${this.capacity}`);
    }
    const start = Date.now();
    while (true) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return Date.now() - start;
      }
      // Tokens needed minus what we have, divided by refill rate = wait time
      const deficit = n - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillPerMs) + 5;
      this.onWait?.({ needed: n, waitMs });
      await this.sleep(waitMs);
    }
  }

  /**
   * Consume tokens without waiting. Returns true if successful, false if
   * there aren't enough. The bucket is unchanged on false.
   */
  tryAcquire(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Force a token count (e.g. record a successful API call's token cost). */
  recordUsage(n: number): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - n);
  }

  /** Reset the bucket to full. */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /** Current token count (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Factory helpers ─────────────────────────────────────────────────────────

/** RPM → token-bucket config. capacity allows short bursts. */
export function rpmLimiter(rpm: number, opts?: { burst?: number; onWait?: RateLimiterOptions['onWait'] }): RateLimiter {
  return new RateLimiter({
    capacity: opts?.burst ?? Math.max(1, Math.ceil(rpm / 6)),  // ~10s burst
    refillPerMs: rpm / 60_000,
    onWait: opts?.onWait,
  });
}

/**
 * TPM (tokens per minute) tracker using a sliding window.
 * Different from RateLimiter: it doesn't block — it just records usage
 * and exposes whether the current window is under the limit. Used to
 * inform the retry layer (don't hammer Google when we're already near TPM).
 */
export class TpmTracker {
  private window: { t: number; tokens: number }[] = [];
  private readonly windowMs: number;
  private readonly limit: number;

  constructor(tokensPerMinute: number, windowMs = 60_000) {
    this.limit = tokensPerMinute;
    this.windowMs = windowMs;
  }

  record(tokens: number, now = Date.now()): void {
    this.window.push({ t: now, tokens });
    this.prune(now);
  }

  used(now = Date.now()): number {
    this.prune(now);
    return this.window.reduce((s, e) => s + e.tokens, 0);
  }

  remaining(now = Date.now()): number {
    return Math.max(0, this.limit - this.used(now));
  }

  /** True if there's room for `n` more tokens right now. */
  hasRoomFor(n: number, now = Date.now()): boolean {
    return this.used(now) + n <= this.limit;
  }

  /** Suggested wait ms before the requested tokens fit, given current usage. */
  waitMsFor(n: number, now = Date.now()): number {
    if (this.hasRoomFor(n, now)) return 0;
    // Find the oldest entry that, when evicted, would free enough room
    let freed = 0;
    for (const entry of this.window) {
      freed += entry.tokens;
      if (this.used(now) - freed + n <= this.limit) {
        return Math.max(0, entry.t + this.windowMs - now);
      }
    }
    return this.windowMs;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.window.length > 0 && this.window[0].t < cutoff) this.window.shift();
  }
}

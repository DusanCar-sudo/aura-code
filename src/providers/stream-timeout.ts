/**
 * Idle-timeout guard for provider response streams.
 *
 * Why this exists: an SSE stream from a cloud provider can go silent without
 * the TCP connection closing — no error event, no terminating chunk, the read
 * just blocks on a chunk that never arrives. Aura would wait forever, showing
 * the user nothing.
 *
 * The SDKs do not cover this. Both openai and @anthropic-ai/sdk default to a
 * 600s `timeout`, but they implement it as:
 *
 *     const timeout = setTimeout(() => controller.abort(), ms);
 *     return fetch(url, opts).finally(() => clearTimeout(timeout));
 *
 * The fetch promise settles when response *headers* arrive — immediately, for
 * a stream — and `.finally()` then cancels the timer. Every chunk of the body
 * is read with no deadline at all. The 600s figure applies to time-to-headers
 * and nothing else.
 *
 * So the deadline has to live here, measured *between chunks* rather than over
 * the whole response. Total-duration limits are the wrong tool: a legitimate
 * turn can run for minutes through tool calls, but a healthy stream never goes
 * quiet for long once tokens are flowing.
 */

/**
 * Milliseconds of silence between chunks before a stream is declared stalled.
 *
 * Calibrated against 529 consecutive-turn intervals from this project's own
 * token log (machine-paced `--auto` runs, no human think-time): median 3.9s,
 * p90 27s. Those measure whole turns *including tool execution*, so they are
 * an upper bound on model time — and inter-chunk gaps are far smaller again,
 * typically sub-second once generation starts. 60s sits well clear of the
 * legitimate distribution while still catching a hang in about a minute.
 *
 * It deliberately does not bound total response time. Slow generation still
 * emits tokens, and each one resets the clock.
 */
export const DEFAULT_STREAM_IDLE_MS = 60_000;

/** Smallest honoured override. Below this, normal generation pauses would trip. */
const MIN_STREAM_IDLE_MS = 5_000;

/** Resolve the idle budget, allowing `AURA_STREAM_IDLE_MS=0` to disable. */
export function streamIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AURA_STREAM_IDLE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STREAM_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_STREAM_IDLE_MS;
  if (n <= 0) return 0;                       // explicit opt-out
  return Math.max(MIN_STREAM_IDLE_MS, Math.floor(n));
}

/** Thrown when a stream produces no chunk within the idle budget. */
export class StreamStalledError extends Error {
  readonly idleMs: number;
  /** Chunks received before the silence — 0 means nothing was ever produced. */
  readonly chunksReceived: number;

  constructor(idleMs: number, chunksReceived: number) {
    super(
      `Provider stream stalled: no data for ${Math.round(idleMs / 1000)}s ` +
      `after ${chunksReceived} chunk(s)`,
    );
    this.name = 'StreamStalledError';
    this.idleMs = idleMs;
    this.chunksReceived = chunksReceived;
  }
}

export function isStreamStalled(e: unknown): e is StreamStalledError {
  return e instanceof StreamStalledError;
}

/**
 * Re-yield `source`, failing with StreamStalledError if any single gap between
 * chunks exceeds `idleMs`. `onStall` fires first so the caller can abort the
 * underlying HTTP request — without that the socket stays open and the process
 * leaks a connection per stall.
 *
 * `idleMs <= 0` disables the guard and passes the source straight through.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  opts: { idleMs: number; onStall?: () => void },
): AsyncGenerator<T> {
  const { idleMs, onStall } = opts;
  if (idleMs <= 0) {
    yield* source;
    return;
  }

  const it = source[Symbol.asyncIterator]();
  let received = 0;

  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StreamStalledError(idleMs, received)), idleMs);
    });

    let step: IteratorResult<T>;
    try {
      // The timer races only the *next* chunk, and is rebuilt each iteration,
      // so the budget is per-gap rather than for the response as a whole.
      step = await Promise.race([it.next(), idle]);
    } catch (err) {
      if (isStreamStalled(err)) {
        // Abort the request before closing the iterator: the pending it.next()
        // resolves only once the underlying fetch is torn down.
        try { onStall?.(); } catch { /* aborting must not mask the stall */ }
        // Not awaited — a stalled iterator may never settle its return().
        void Promise.resolve(it.return?.(undefined as never)).catch(() => {});
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (step.done) return;
    received++;
    yield step.value;
  }
}

import { ApiError } from './errors.js';

export interface RetryOptions {
  /** Maximum number of attempts (not retries — total tries including the first). Default 5. */
  maxAttempts?: number;
  /** Base delay in ms for the backoff. Default 1000. */
  baseDelayMs?: number;
  /** Maximum delay between retries. Default 30000 (30s). */
  maxDelayMs?: number;
  /** Multiplier per attempt. Default 2. */
  factor?: number;
  /** Jitter factor 0..1. Default 0.25. */
  jitter?: number;
  /** Called before each retry with the attempt number and the upcoming delay. */
  onRetry?: (info: { attempt: number; delayMs: number; error: ApiError }) => void;
  /** Abort signal — abort waits between retries. */
  signal?: AbortSignal;
  /** Sleep function for testing. Default global setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wrap an async function with exponential backoff and jitter.
 * - Honours the error's `retryAfterMs` if set (e.g. parsed from Retry-After header).
 * - Only retries ApiError instances where `retriable === true`.
 * - Re-throws the last error if all attempts fail.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.25;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: ApiError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('Aborted');
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError({
        message: String(e), provider: 'unknown', retriable: false, cause: e,
      });
      lastErr = err;
      if (!err.retriable || attempt === maxAttempts) throw err;

      const delay = computeDelay({
        attempt, base, max, factor, jitter,
        retryAfter: err.retryAfterMs,
      });
      opts.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err });
      if (opts.signal?.aborted) throw new Error('Aborted');
      await sleep(delay);
    }
  }
  throw lastErr ?? new ApiError({ message: 'withRetry exhausted', provider: 'unknown' });
}

function computeDelay(opts: {
  attempt: number; base: number; max: number; factor: number; jitter: number; retryAfter?: number;
}): number {
  // If the server told us when to retry, prefer that (capped to max).
  if (opts.retryAfter !== undefined) {
    return Math.min(opts.max, Math.max(opts.retryAfter, 0));
  }
  const exp = opts.base * Math.pow(opts.factor, opts.attempt - 1);
  const capped = Math.min(opts.max, exp);
  const jittered = capped * (1 - opts.jitter + Math.random() * opts.jitter * 2);
  return Math.round(jittered);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

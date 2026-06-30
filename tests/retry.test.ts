import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/util/retry.js';
import { ApiError } from '../src/util/errors.js';

function err429(retryAfterMs?: number): ApiError {
  return new ApiError({ message: 'rate limited', status: 429, provider: 'X', retriable: true, retryAfterMs });
}
function err400(): ApiError {
  return new ApiError({ message: 'bad request', status: 400, provider: 'X', retriable: false });
}

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const out = await withRetry(fn);
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retriable errors and eventually succeeds', async () => {
    let n = 0;
    const fn = vi.fn().mockImplementation(() => {
      n++;
      if (n < 3) throw err429();
      return Promise.resolve('done');
    });
    const out = await withRetry(fn, { sleep: () => Promise.resolve() });
    expect(out).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retriable errors', async () => {
    const fn = vi.fn().mockRejectedValue(err400());
    await expect(withRetry(fn, { sleep: () => Promise.resolve() })).rejects.toBeInstanceOf(ApiError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(err429());
    await expect(withRetry(fn, { maxAttempts: 3, sleep: () => Promise.resolve() })).rejects.toThrow(/rate limited/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours retryAfter from error over backoff', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(err429(5000));
    await expect(withRetry(fn, {
      maxAttempts: 2, sleep: () => Promise.resolve(), onRetry,
    })).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 5000 }));
  });

  it('uses exponential backoff when no retryAfter', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(err429());
    await expect(withRetry(fn, {
      maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10_000, jitter: 0,
      sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
    })).rejects.toThrow();
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);
  });

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(err429());
    await expect(withRetry(fn, {
      maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 1500, jitter: 0,
      sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
    })).rejects.toThrow();
    expect(delays.every(d => d <= 1500)).toBe(true);
  });

  it('aborts when signal is already aborted', async () => {
    const fn = vi.fn().mockRejectedValue(err429());
    const controller = new AbortController();
    controller.abort();
    await expect(withRetry(fn, { signal: controller.signal, sleep: () => Promise.resolve() })).rejects.toThrow(/Aborted/);
    expect(fn).toHaveBeenCalledTimes(0);
  });
});

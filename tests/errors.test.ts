import { describe, it, expect } from 'vitest';
import { ApiError, defaultRetriable, normaliseError } from '../src/util/errors.js';

describe('defaultRetriable', () => {
  it('treats 429, 529, 5xx as retriable', () => {
    expect(defaultRetriable(429)).toBe(true);
    expect(defaultRetriable(529)).toBe(true);
    expect(defaultRetriable(500)).toBe(true);
    expect(defaultRetriable(502)).toBe(true);
    expect(defaultRetriable(503)).toBe(true);
    expect(defaultRetriable(504)).toBe(true);
    expect(defaultRetriable(408)).toBe(true);
  });
  it('treats 4xx (except 429) as not retriable', () => {
    expect(defaultRetriable(400)).toBe(false);
    expect(defaultRetriable(401)).toBe(false);
    expect(defaultRetriable(403)).toBe(false);
    expect(defaultRetriable(404)).toBe(false);
  });
  it('treats status 0 (network) as retriable', () => {
    expect(defaultRetriable(0)).toBe(true);
  });
});

describe('normaliseError', () => {
  it('returns ApiError unchanged', () => {
    const e = new ApiError({ message: 'x', provider: 'p', retriable: true });
    expect(normaliseError(e, 'p')).toBe(e);
  });

  it('extracts status from Anthropic-style error', () => {
    const e = normaliseError({ status: 429, message: 'rate limited' }, 'Anthropic');
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(429);
    expect(e.retriable).toBe(true);
    expect(e.provider).toBe('Anthropic');
  });

  it('extracts retryAfter from headers (seconds)', () => {
    const e = normaliseError({ status: 429, headers: { 'retry-after': '27' } }, 'Anthropic');
    expect(e.retryAfterMs).toBe(27_000);
  });

  it('extracts retryAfter from Google errorDetails.retryDelay (seconds)', () => {
    const e = normaliseError({
      status: 429,
      errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' }],
    }, 'Google');
    expect(e.retryAfterMs).toBe(32_000);
  });

  it('extracts retryAfter from Google errorDetails.retryDelay (ms)', () => {
    const e = normaliseError({
      status: 429,
      errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1500ms' }],
    }, 'Google');
    expect(e.retryAfterMs).toBe(1500);
  });

  it('treats ETIMEDOUT as network error (status 0)', () => {
    const e = normaliseError({ code: 'ETIMEDOUT', message: 'x' }, 'Anthropic');
    expect(e.status).toBe(0);
    expect(e.retriable).toBe(true);
  });

  it('preserves cause chain', () => {
    const orig = new Error('boom');
    const e = normaliseError(orig, 'Anthropic');
    expect(e.cause).toBe(orig);
  });
});

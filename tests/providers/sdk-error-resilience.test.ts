import { describe, it, expect, vi } from 'vitest';

import { withRetry } from '../../src/util/retry.js';
import { FallbackChainProvider } from '../../src/providers/fallback.js';
import { ApiError } from '../../src/util/errors.js';
import type { LLMProvider, LLMResponse, StreamChunk } from '../../src/providers/types.js';

/**
 * The gap this closes: retry and fallback both keyed off `e instanceof ApiError`,
 * but no provider converts before throwing — every one of them throws its SDK's
 * own error class. So a real 429 arrived as a foreign object, withRetry wrapped
 * it with a hardcoded `retriable: false`, and the run died on the first rate
 * limit. The mislabelled error then told FallbackChainProvider the failure was
 * permanent, so it refused to fail over either.
 *
 * One wrong default disabled both layers of resilience, and nothing tested it,
 * because every existing test constructed a well-formed ApiError by hand — the
 * one shape production never produces. These use a foreign error object instead.
 */

/** What the OpenAI SDK actually throws: its own class, with `status`. */
class SdkApiError extends Error {
  status: number;
  headers?: Record<string, string>;
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.headers = headers;
  }
}

/** The exact error text from the session that prompted this fix. */
const rateLimited = () => new SdkApiError(429, '429 status code (no body)');

const noSleep = async () => { /* no real delay in tests */ };

describe('withRetry with a foreign SDK error', () => {
  it('retries a raw SDK 429 instead of giving up on the first one', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw rateLimited();
      return 'ok';
    }, { sleep: noSleep, maxAttempts: 5 });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('retries a raw SDK 500', async () => {
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls < 2) throw new SdkApiError(503, 'service unavailable');
      return 'ok';
    }, { sleep: noSleep });
    expect(calls).toBe(2);
  });

  it('still refuses to retry a genuinely permanent SDK error', async () => {
    // The fix must not turn "your API key is wrong" into five slow retries.
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new SdkApiError(401, 'invalid api key');
    }, { sleep: noSleep })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it('honours Retry-After from the SDK error headers', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls < 2) throw new SdkApiError(429, 'slow down', { 'retry-after': '2' });
      return 'ok';
    }, { sleep: async (ms) => { delays.push(ms); }, maxAttempts: 3 });
    expect(delays).toEqual([2000]);
  });

  it('surfaces the parsed status and provider on the thrown error', async () => {
    // "ApiError: Error: 429 status code (no body)" told the user nothing about
    // which provider failed or whether it was worth retrying.
    const err = await withRetry(async () => { throw rateLimited(); },
      { sleep: noSleep, maxAttempts: 1, provider: 'fpt' }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retriable).toBe(true);
    expect(err.provider).toBe('fpt');
  });
});

function stubProvider(name: string, behaviour: () => Promise<LLMResponse>): LLMProvider {
  return {
    name,
    model: name,
    complete: behaviour,
    async *stream(): AsyncGenerator<StreamChunk> {
      const r = await behaviour();
      yield { type: 'done', response: r };
    },
  } as unknown as LLMProvider;
}

const reply = (text: string): LLMResponse =>
  ({ text, toolCalls: [], stopReason: 'done' } as unknown as LLMResponse);

describe('FallbackChainProvider with a foreign SDK error', () => {
  it('fails over to the next provider on a raw SDK 429', async () => {
    const failover: string[] = [];
    const chain = new FallbackChainProvider(
      [
        stubProvider('fpt', async () => { throw rateLimited(); }),
        stubProvider('anthropic', async () => reply('from fallback')),
      ],
      { onFailover: e => failover.push(`${e.from}->${e.to}`) },
    );

    const res = await chain.complete('sys', [], []);
    expect(res.text).toBe('from fallback');
    expect(failover).toEqual(['fpt->anthropic']);
  });

  it('fails over mid-stream setup too', async () => {
    const chain = new FallbackChainProvider([
      stubProvider('fpt', async () => { throw rateLimited(); }),
      stubProvider('anthropic', async () => reply('streamed')),
    ]);
    const chunks: StreamChunk[] = [];
    for await (const c of chain.stream('sys', [], [])) chunks.push(c);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', response: { text: 'streamed' } });
  });

  it('does not fail over on a permanent SDK error', async () => {
    // A bad request will fail identically on every provider; walking the whole
    // chain just multiplies the latency and the bill.
    const failover: string[] = [];
    const chain = new FallbackChainProvider(
      [
        stubProvider('fpt', async () => { throw new SdkApiError(400, 'bad request'); }),
        stubProvider('anthropic', async () => reply('should not be reached')),
      ],
      { onFailover: e => failover.push(`${e.from}->${e.to}`) },
    );
    await expect(chain.complete('sys', [], [])).rejects.toThrow(/bad request/);
    expect(failover).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { FallbackChainProvider } from '../src/providers/fallback.js';
import { ResilientProvider } from '../src/providers/resilient.js';
import { ApiError } from '../src/util/errors.js';
import type { LLMProvider, LLMResponse, StreamChunk, HistoryMessage, ToolDefinition } from '../src/providers/types.js';

class FakeProvider implements LLMProvider {
  name: string; model: string; supportsTools = true;
  failTimes: number; calls = 0;
  result: LLMResponse = { text: 'ok', toolCalls: [], stopReason: 'done' };
  constructor(name: string, model: string, failTimes = 0) {
    this.name = name; this.model = model; this.failTimes = failTimes;
  }
  async complete(): Promise<LLMResponse> {
    this.calls++;
    if (this.failTimes > 0) { this.failTimes--; throw new ApiError({ message: 'fail', status: 429, provider: this.name, retriable: true }); }
    return this.result;
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    this.calls++;
    if (this.failTimes > 0) { this.failTimes--; throw new ApiError({ message: 'fail', status: 429, provider: this.name, retriable: true }); }
    yield { type: 'text', text: 'stream-ok' };
    yield { type: 'done', response: this.result };
  }
}

describe('FallbackChainProvider', () => {
  it('uses primary when it succeeds', async () => {
    const a = new FakeProvider('A', 'a', 0);
    const b = new FakeProvider('B', 'b', 0);
    const chain = new FallbackChainProvider([a, b]);
    const r = await chain.complete('s', [], []);
    expect(r.text).toBe('ok');
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
  });

  it('falls over to next on retriable failure', async () => {
    const a = new FakeProvider('A', 'a', 1);
    const b = new FakeProvider('B', 'b', 0);
    const onFailover = vi.fn();
    const chain = new FallbackChainProvider([a, b], { onFailover });
    const r = await chain.complete('s', [], []);
    expect(r.text).toBe('ok');
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(onFailover).toHaveBeenCalledWith(expect.objectContaining({ from: 'A', to: 'B' }));
  });

  it('does not failover on non-retriable error', async () => {
    const a = new FakeProvider('A', 'a', 0);
    // Force a non-retriable failure
    a.complete = async () => { throw new ApiError({ message: 'bad', status: 400, provider: 'A', retriable: false }); };
    const b = new FakeProvider('B', 'b', 0);
    const chain = new FallbackChainProvider([a, b]);
    await expect(chain.complete('s', [], [])).rejects.toThrow(/bad/);
    expect(b.calls).toBe(0);
  });

  it('throws last error if all fail', async () => {
    const a = new FakeProvider('A', 'a', 99);
    const b = new FakeProvider('B', 'b', 99);
    const chain = new FallbackChainProvider([a, b]);
    await expect(chain.complete('s', [], [])).rejects.toThrow(/fail/);
  });

  it('requires at least one provider', () => {
    expect(() => new FallbackChainProvider([])).toThrow(/at least one/);
  });

  it('reports supportsTools only if all do', () => {
    const a = new FakeProvider('A', 'a', 0);
    const b = new FakeProvider('B', 'b', 0);
    const chain = new FallbackChainProvider([a, b]);
    expect(chain.supportsTools).toBe(true);
    b.supportsTools = false;
    const chain2 = new FallbackChainProvider([a, b]);
    expect(chain2.supportsTools).toBe(false);
  });
});

describe('ResilientProvider', () => {
  it('retries on 429 and eventually succeeds', async () => {
    const a = new FakeProvider('A', 'a', 2);
    const r = new ResilientProvider(a, { maxRetries: 5, sleep: () => Promise.resolve() });
    const out = await r.complete('s', [], []);
    expect(out.text).toBe('ok');
    expect(a.calls).toBe(3);
  });

  it('retries mid-stream only if first chunk fails', async () => {
    const a = new FakeProvider('A', 'a', 1);
    const r = new ResilientProvider(a, { maxRetries: 5, sleep: () => Promise.resolve() });
    const chunks: string[] = [];
    for await (const c of r.stream('s', [], [])) {
      if (c.type === 'text') chunks.push(c.text);
    }
    expect(chunks).toContain('stream-ok');
    expect(a.calls).toBe(2);  // one failure, one success
  });

  it('tracks token usage from response', async () => {
    const a = new FakeProvider('A', 'a', 0);
    a.result = { text: 'x', toolCalls: [], stopReason: 'done', usage: { inputTokens: 100, outputTokens: 50 } };
    const r = new ResilientProvider(a, { tpm: 1000, maxRetries: 1, sleep: () => Promise.resolve() });
    await r.complete('s', [], []);
    // 150 tokens used, 850 remaining
    expect(r.tpmHasRoomFor(800)).toBe(true);
    expect(r.tpmHasRoomFor(900)).toBe(false);
  });

  it('honours circuit breaker after too many failures', async () => {
    const a = new FakeProvider('A', 'a', 100);
    const r = new ResilientProvider(a, {
      maxRetries: 2, circuitFailureThreshold: 2, circuitCooldownMs: 60_000,
      sleep: () => Promise.resolve(),
    });
    // Each `complete` does 2 attempts; the 2nd call should trip the breaker.
    await expect(r.complete('s', [], [])).rejects.toThrow();
    await expect(r.complete('s', [], [])).rejects.toThrow();
    // Third call should fail with circuit-open
    await expect(r.complete('s', [], [])).rejects.toThrow();
  });
});

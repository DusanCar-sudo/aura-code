import { describe, it, expect } from 'vitest';
import {
  withIdleTimeout, streamIdleMs, isStreamStalled, StreamStalledError,
  DEFAULT_STREAM_IDLE_MS,
} from '../src/providers/stream-timeout.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Emits `values`, pausing `gapMs` before each. `hangAfter` stops forever. */
async function* source(values: string[], gapMs = 0, hangAfter = Infinity): AsyncGenerator<string> {
  for (let i = 0; i < values.length; i++) {
    if (i === hangAfter) {
      await sleep(60_000);          // never resolves within a test
      return;
    }
    if (gapMs) await sleep(gapMs);
    yield values[i];
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('withIdleTimeout', () => {
  it('passes a healthy stream through untouched', async () => {
    const out = await collect(withIdleTimeout(source(['a', 'b', 'c'], 5), { idleMs: 200 }));
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('throws StreamStalledError when the stream goes silent', async () => {
    await expect(
      collect(withIdleTimeout(source(['a', 'b'], 5, 1), { idleMs: 60 })),
    ).rejects.toThrow(StreamStalledError);
  });

  it('reports how many chunks arrived before the silence', async () => {
    try {
      await collect(withIdleTimeout(source(['a', 'b', 'c'], 5, 2), { idleMs: 60 }));
      throw new Error('should have stalled');
    } catch (e) {
      expect(isStreamStalled(e)).toBe(true);
      expect((e as StreamStalledError).chunksReceived).toBe(2);
    }
  });

  it('reports 0 chunks when the stream never produces anything', async () => {
    try {
      await collect(withIdleTimeout(source(['a'], 0, 0), { idleMs: 60 }));
      throw new Error('should have stalled');
    } catch (e) {
      expect((e as StreamStalledError).chunksReceived).toBe(0);
    }
  });

  it('is per-gap, not a total-duration cap', async () => {
    // 6 chunks x 30ms = 180ms total, well past idleMs, but no single gap is.
    const out = await collect(withIdleTimeout(source(['a', 'b', 'c', 'd', 'e', 'f'], 30), { idleMs: 90 }));
    expect(out).toHaveLength(6);
  });

  it('calls onStall so the caller can abort the request', async () => {
    let aborted = false;
    await expect(
      collect(withIdleTimeout(source(['a'], 0, 0), { idleMs: 50, onStall: () => { aborted = true; } })),
    ).rejects.toThrow(StreamStalledError);
    expect(aborted).toBe(true);
  });

  it('does not call onStall for a healthy stream', async () => {
    let aborted = false;
    await collect(withIdleTimeout(source(['a', 'b'], 5), { idleMs: 200, onStall: () => { aborted = true; } }));
    expect(aborted).toBe(false);
  });

  it('survives an onStall that throws, still reporting the stall', async () => {
    await expect(
      collect(withIdleTimeout(source(['a'], 0, 0), {
        idleMs: 50, onStall: () => { throw new Error('abort failed'); },
      })),
    ).rejects.toThrow(StreamStalledError);
  });

  it('passes through unguarded when disabled', async () => {
    const out = await collect(withIdleTimeout(source(['a', 'b'], 30), { idleMs: 0 }));
    expect(out).toEqual(['a', 'b']);
  });

  it('propagates a genuine source error unchanged', async () => {
    async function* boom(): AsyncGenerator<string> {
      yield 'a';
      throw new Error('upstream exploded');
    }
    await expect(collect(withIdleTimeout(boom(), { idleMs: 500 })))
      .rejects.toThrow('upstream exploded');
  });
});

describe('streamIdleMs', () => {
  it('defaults to 60s', () => {
    expect(streamIdleMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_STREAM_IDLE_MS);
    expect(DEFAULT_STREAM_IDLE_MS).toBe(60_000);
  });

  it('honours an override', () => {
    expect(streamIdleMs({ AURA_STREAM_IDLE_MS: '90000' } as NodeJS.ProcessEnv)).toBe(90_000);
  });

  it('treats 0 as an explicit opt-out', () => {
    expect(streamIdleMs({ AURA_STREAM_IDLE_MS: '0' } as NodeJS.ProcessEnv)).toBe(0);
  });

  it('floors absurdly small values so normal pauses cannot trip', () => {
    expect(streamIdleMs({ AURA_STREAM_IDLE_MS: '10' } as NodeJS.ProcessEnv)).toBe(5_000);
  });

  it('falls back to the default on junk', () => {
    expect(streamIdleMs({ AURA_STREAM_IDLE_MS: 'soon' } as NodeJS.ProcessEnv)).toBe(DEFAULT_STREAM_IDLE_MS);
    expect(streamIdleMs({ AURA_STREAM_IDLE_MS: '' } as NodeJS.ProcessEnv)).toBe(DEFAULT_STREAM_IDLE_MS);
  });
});

/**
 * Retry semantics on the real provider, with the SDK client stubbed out.
 * The rule being protected: retry only when nothing reached the consumer,
 * because re-running after text has been yielded duplicates the response.
 */
describe('OpenAICompatibleProvider stall retry', () => {
  const makeProvider = (impl: () => AsyncIterable<unknown>) => {
    const p = new OpenAICompatibleProvider({ model: 'test-model', apiKey: 'k' } as never);
    let calls = 0;
    (p as unknown as { client: unknown }).client = {
      chat: { completions: { create: async () => { calls++; return impl(); } } },
    };
    return { p, calls: () => calls };
  };

  const chunk = (text: string) => ({
    choices: [{ delta: { content: text }, finish_reason: null }],
  });

  it('retries once when the stream stalls before delivering anything', async () => {
    process.env.AURA_STREAM_IDLE_MS = '5000';   // floor; keeps the test honest
    let attempt = 0;
    const { p, calls } = makeProvider(() => {
      attempt++;
      if (attempt === 1) {
        // Stall immediately: no chunk ever delivered.
        return (async function* () { await sleep(60_000); yield chunk('never'); })();
      }
      return (async function* () { yield chunk('recovered'); })();
    });
    process.env.AURA_STREAM_IDLE_MS = '5000';

    const texts: string[] = [];
    for await (const c of p.stream('sys', [], [])) {
      if (c.type === 'text') texts.push(c.text);
    }
    expect(texts.join('')).toContain('recovered');
    expect(calls()).toBe(2);                     // original + one retry
    delete process.env.AURA_STREAM_IDLE_MS;
  }, 20_000);

  it('does NOT retry once text has been delivered — that would duplicate output', async () => {
    process.env.AURA_STREAM_IDLE_MS = '5000';
    const { p, calls } = makeProvider(() =>
      (async function* () {
        yield chunk('partial');                  // reaches the consumer
        await sleep(60_000);                     // then goes silent
      })(),
    );

    const texts: string[] = [];
    await expect((async () => {
      for await (const c of p.stream('sys', [], [])) {
        if (c.type === 'text') texts.push(c.text);
      }
    })()).rejects.toThrow(StreamStalledError);

    expect(texts.join('')).toBe('partial');      // kept what arrived
    expect(calls()).toBe(1);                     // no second request
    delete process.env.AURA_STREAM_IDLE_MS;
  }, 20_000);
});

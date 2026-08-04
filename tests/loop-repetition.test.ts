import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same stub as loop.test.ts: the compaction/summary path calls the real
// createProvider, which would otherwise depend on ambient shell env and could
// make a live network call.
vi.mock('../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 100_000 : mod.getContextWindow(m)),
    createProvider: () => ({
      name: 'stub-summary-provider',
      model: 'stub',
      supportsTools: false,
      complete: async () => ({ text: '- stub fact', toolCalls: [], stopReason: 'done' as const }),
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done', response: { text: '', toolCalls: [], stopReason: 'done' } };
      },
    }),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentLoop } from '../src/agent/loop.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

/**
 * The run this reproduces: stepfun/step-3.5-flash was asked to build a large
 * HTML page, collapsed into "Writing the HTML structure... " a few hundred
 * times, spent its whole 16,384-token output allowance, returned stopReason
 * 'limit', and the task ended with nothing written. Every attempt in that
 * session did the same.
 */

const COLLAPSE = 'Writing the HTML structure... ';

/** Streams a collapsed reply — the phrase over and over, then truncated by the
 *  provider's output cap, exactly as the real one reported it. */
class CollapsingProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  /** Chunks actually yielded before the consumer walked away. */
  chunksYielded = 0;
  /** Set by the generator's finally — proves the request was torn down. */
  aborted = false;
  constructor(private collapses = Infinity, private then?: LLMResponse) {}
  private calls = 0;

  async complete(): Promise<LLMResponse> {
    return { text: '', toolCalls: [], stopReason: 'done' };
  }

  async *stream(): AsyncGenerator<StreamChunk> {
    const collapsing = this.calls++ < this.collapses;
    if (!collapsing) {
      const r = this.then ?? { text: 'done properly', toolCalls: [], stopReason: 'done' as const };
      if (r.text) yield { type: 'text', text: r.text };
      yield { type: 'done', response: r };
      return;
    }
    try {
      // ~65 KB is what a 16k-token output allowance buys.
      for (let i = 0; i < 2200; i++) {
        this.chunksYielded++;
        yield { type: 'text', text: COLLAPSE };
      }
      yield {
        type: 'done',
        response: {
          text: COLLAPSE.repeat(2200), toolCalls: [], stopReason: 'limit',
          usage: { inputTokens: 1000, outputTokens: 16384, cachedTokens: 0 },
        },
      };
    } finally {
      this.aborted = true;
    }
  }
}

const noopDisplay = new Proxy({} as Display, { get: () => () => {} });

describe('a reply that collapses into repetition', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-loop-rep-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
    vi.stubEnv('AURA_SESSION_BUDGET', '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const run = async (provider: LLMProvider) => {
    const ctx = await loadProjectContext(tmpDir);
    return runAgentLoop({
      provider, task: 'build the landing page', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      disableSpawn: true, checkpoints: false,
    });
  };

  it('is cut off long before the output cap, and the request is torn down', async () => {
    const provider = new CollapsingProvider();
    await run(provider);

    // The whole point: stop paying for the loop. 2,200 chunks is what the model
    // would have produced; the guard must walk away after a small fraction.
    expect(provider.chunksYielded).toBeLessThan(300);
    expect(provider.aborted).toBe(true);
  });

  it('recovers when the retry comes back clean', async () => {
    const provider = new CollapsingProvider(1, {
      text: 'Wrote index.html.', toolCalls: [], stopReason: 'done',
    });
    const result = await run(provider);

    expect(result.success).toBe(true);
    expect(result.summary).toBe('Wrote index.html.');
  });

  it('never puts the repeated text into history', async () => {
    // A model shown its own loop continues it, which is why every later turn in
    // that session repeated too. The degenerate text must not survive the turn.
    const provider = new CollapsingProvider(1, {
      text: 'Wrote index.html.', toolCalls: [], stopReason: 'done',
    });
    const result = await run(provider);

    const worst = Math.max(...result.history.map(m => (m.content ?? '').length));
    expect(worst).toBeLessThan(2000);
    for (const m of result.history) {
      const reps = ((m.content ?? '').match(/Writing the HTML structure/g) ?? []).length;
      expect(reps).toBeLessThan(5);
    }
  });

  it('tells the model what went wrong so the retry differs', async () => {
    const provider = new CollapsingProvider(1, {
      text: 'Wrote index.html.', toolCalls: [], stopReason: 'done',
    });
    const result = await run(provider);

    const correction = result.history.find(
      m => m.role === 'user' && /collapsed/i.test(m.content ?? ''),
    );
    expect(correction).toBeDefined();
    expect(correction!.content).toMatch(/write_file/);
  });

  it('gives up with a model-blaming summary when it keeps collapsing', async () => {
    const result = await run(new CollapsingProvider());

    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/collapsed into repetition/i);
    // The user's next move is a different model, and the message should say so
    // rather than implying their task was at fault.
    expect(result.summary).toMatch(/model/i);
    expect(result.turns).toBeLessThan(6);
  });
});

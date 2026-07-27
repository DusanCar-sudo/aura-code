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
import { SessionBudget, DEFAULT_MAX_INPUT_TOKENS } from '../src/agent/session-budget.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

const noopDisplay = new Proxy({} as Display, { get: () => () => {} });

class FakeProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  constructor(private responses: LLMResponse[]) {}
  async complete(): Promise<LLMResponse> {
    return { text: '- distilled', toolCalls: [], stopReason: 'done' };
  }
  async *stream(_s: string, _h: HistoryMessage[]): AsyncGenerator<StreamChunk> {
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses queued');
    if (next.text) yield { type: 'text', text: next.text };
    yield { type: 'done', response: next };
  }
}

/** One "user message" worth of work: text reply carrying the given usage. */
const reply = (text: string, inputTokens: number, cachedTokens = 0): LLMResponse => ({
  text, toolCalls: [], stopReason: 'done',
  usage: { inputTokens, outputTokens: 10, cachedTokens },
});

describe('REPL session budget', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-repl-budget-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const run = async (provider: LLMProvider, budget: SessionBudget) => {
    const ctx = await loadProjectContext(tmpDir);
    return runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      budget,
    });
  };

  it('accumulates spend across separate user messages instead of resetting', async () => {
    // The bug this guards: each REPL message starts a fresh runAgentLoop, so a
    // per-invocation counter would report 1 turn / 1000 tokens three times over
    // rather than a growing total.
    const budget = new SessionBudget({});
    for (const n of [1, 2, 3]) {
      const r = await run(new FakeProvider([reply(`msg ${n}`, 1000)]), budget);
      expect(r.turns).toBe(1);                     // per-invocation counter restarts…
    }
    expect(budget.turnsUsed).toBe(3);              // …while the session total grows
    expect(budget.inputTokensUsed).toBe(3000);
  });

  it('counts input net of cache hits, not raw prompt size', async () => {
    const budget = new SessionBudget({});
    await run(new FakeProvider([reply('a', 10_000, 9_000)]), budget);
    expect(budget.inputTokensUsed).toBe(1_000);
  });

  it('never stops on turn count when constructed without maxTurns', async () => {
    // The deliberate REPL choice: a human is present for every message, so a
    // cumulative turn ceiling would interrupt cheap supervised work.
    const budget = new SessionBudget({});
    expect(budget.maxTurns).toBe(Infinity);
    for (let i = 0; i < 60; i++) budget.recordTurn();   // well past the 50 used elsewhere
    expect(budget.turnsUsed).toBe(60);
    expect(budget.exhausted()).toBeNull();
  });

  it('still stops on the token ceiling', async () => {
    const budget = new SessionBudget({ maxInputTokens: 2_500 });
    for (const n of [1, 2, 3]) {
      if (budget.exhausted()) break;
      await run(new FakeProvider([reply(`msg ${n}`, 1000)]), budget);
    }
    const stop = budget.exhausted();
    expect(stop).not.toBeNull();
    expect(stop!.kind).toBe('tokens');
    expect(budget.inputTokensUsed).toBeGreaterThanOrEqual(2_500);
  });

  it('defaults to the 1M net-of-cache ceiling', () => {
    expect(new SessionBudget({}).maxInputTokens).toBe(DEFAULT_MAX_INPUT_TOKENS);
    expect(DEFAULT_MAX_INPUT_TOKENS).toBe(1_000_000);
  });

  it('leaves the per-invocation maxTurns guard intact', async () => {
    // The guard that actually catches a runaway loop within one message.
    const budget = new SessionBudget({});
    const ctx = await loadProjectContext(tmpDir);
    const provider = new FakeProvider(
      Array.from({ length: 10 }, (_, i) => ({
        text: '', stopReason: 'tools' as const,
        toolCalls: [{ id: `t${i}`, name: 'list_dir', input: { path: '.' } }],
        usage: { inputTokens: 100, outputTokens: 1 },
      })),
    );
    const r = await runAgentLoop({
      provider, task: 'loop', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      budget, maxTurns: 3,
    });
    expect(r.turns).toBe(3);                       // capped within the message
    expect(budget.turnsUsed).toBe(3);              // and counted toward the session
  });
});

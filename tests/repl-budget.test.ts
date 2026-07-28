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
import {
  SessionBudget, DEFAULT_MAX_INPUT_TOKENS,
  maxInputTokensFromEnv, resetBudgetEnvWarning,
} from '../src/agent/session-budget.js';
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
    vi.stubEnv('AURA_SESSION_BUDGET', '');   // ignore an exported override
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

  it('starts a new session from zero, so :new clears an exhausted budget', async () => {
    // The reported bug: `:new` minted a session id and emptied history but the
    // total lived on the REPL process, so the next message was refused before
    // it ran — and the exhaustion message recommends `:new` as the way out.
    const budget = new SessionBudget({ maxInputTokens: 2_500 });
    for (const n of [1, 2, 3]) {
      if (budget.exhausted()) break;
      await run(new FakeProvider([reply(`msg ${n}`, 1000)]), budget);
    }
    expect(budget.exhausted()).not.toBeNull();     // blocked, as it was for real

    budget.reset();                                // what `:new` now does

    expect(budget.inputTokensUsed).toBe(0);
    expect(budget.turnsUsed).toBe(0);
    expect(budget.exhausted()).toBeNull();

    // and the next message actually runs rather than being refused
    const r = await run(new FakeProvider([reply('after :new', 1000)]), budget);
    expect(r.turns).toBe(1);
    expect(budget.inputTokensUsed).toBe(1000);     // counted from zero, not 3000+
  });

  it('keeps the configured ceilings across a reset', () => {
    // A reset must clear what was spent, not what is allowed — otherwise `:new`
    // would quietly widen or drop the guard.
    const budget = new SessionBudget({ maxTurns: 7, maxInputTokens: 2_500 });
    budget.recordCall(2_600);
    budget.recordTurn();
    budget.reset();
    expect(budget.maxTurns).toBe(7);
    expect(budget.maxInputTokens).toBe(2_500);
    expect(budget.exhausted()).toBeNull();
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

describe('AURA_SESSION_BUDGET override', () => {
  beforeEach(() => { resetBudgetEnvWarning(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('keeps the 1M default when unset or empty', () => {
    expect(maxInputTokensFromEnv(undefined)).toBe(DEFAULT_MAX_INPUT_TOKENS);
    expect(maxInputTokensFromEnv('')).toBe(DEFAULT_MAX_INPUT_TOKENS);
    expect(maxInputTokensFromEnv('   ')).toBe(DEFAULT_MAX_INPUT_TOKENS);
  });

  it('treats 0 as no ceiling', () => {
    expect(maxInputTokensFromEnv('0')).toBe(Infinity);
  });

  it('accepts an explicit ceiling', () => {
    expect(maxInputTokensFromEnv('5000000')).toBe(5_000_000);
    expect(maxInputTokensFromEnv(' 250000 ')).toBe(250_000);
  });

  it('falls back to the default on a malformed value, never to unlimited', () => {
    // Failing open on a typo would silently remove the guard — the one
    // outcome this must not have.
    for (const bad of ['lots', '-1', 'NaN', '1e', '1,000,000']) {
      expect(maxInputTokensFromEnv(bad)).toBe(DEFAULT_MAX_INPUT_TOKENS);
    }
  });

  it('is read by the constructor when no explicit ceiling is passed', () => {
    vi.stubEnv('AURA_SESSION_BUDGET', '0');
    expect(new SessionBudget({}).maxInputTokens).toBe(Infinity);
    vi.stubEnv('AURA_SESSION_BUDGET', '4000000');
    expect(new SessionBudget({}).maxInputTokens).toBe(4_000_000);
  });

  it('never overrides an explicit ceiling from the caller', () => {
    vi.stubEnv('AURA_SESSION_BUDGET', '0');
    expect(new SessionBudget({ maxInputTokens: 2_500 }).maxInputTokens).toBe(2_500);
  });

  it('does not disable the guard for anyone who has not opted in', () => {
    vi.stubEnv('AURA_SESSION_BUDGET', '');
    const budget = new SessionBudget({});
    expect(budget.maxInputTokens).toBe(DEFAULT_MAX_INPUT_TOKENS);
    budget.recordCall(DEFAULT_MAX_INPUT_TOKENS);
    expect(budget.exhausted()).toMatchObject({ kind: 'tokens' });
  });
});

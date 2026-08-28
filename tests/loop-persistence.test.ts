import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same stub as loop.test.ts: the compaction/summary path calls the real
// createProvider, which would otherwise depend on ambient shell env and could
// make a live network call.
vi.mock('../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 200_000 : mod.getContextWindow(m)),
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
import { SessionBudget } from '../src/agent/session-budget.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse, ToolCall,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

/**
 * The complaint this closes: "I need to be next to it to type resume after
 * every limit." Two of the three routine stops were guards that halted a run
 * and handed the decision to a human who had no more information than the loop
 * did — the turn cap, and the stall detector.
 *
 * Neither is deleted. The turn cap now extends while SessionBudget still has
 * token headroom (the budget is the meaningful ceiling; turns are a proxy),
 * and a stall now provokes a correction before it provokes a stop. What must
 * not regress is the other half: a run with no budget, or a model that ignores
 * three explicit corrections, still has to terminate.
 */

const noopDisplay = new Proxy({} as Display, { get: () => () => {} });

// The stall signature is {name, input} — the call id is deliberately excluded,
// so a fixture that only varies its id still reads as a repeat.
const READ = (i: number, file = 'package.json'): ToolCall =>
  ({ id: `c${i}`, name: 'read_file', input: { path: file } });

/** Always makes the same read_file call — the shape that trips 'repeat'. */
class StuckProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  turns = 0;
  /** After this many turns, stop looping and finish cleanly. */
  constructor(private recoverAfter = Infinity) {}

  async complete(): Promise<LLMResponse> {
    return { text: '- distilled fact', toolCalls: [], stopReason: 'done' };
  }

  async *stream(_s: string, history: HistoryMessage[]): AsyncGenerator<StreamChunk> {
    this.turns++;
    // Recover once the loop has told it to change approach.
    const nudged = history.filter(
      m => m.role === 'user' && /change approach/i.test(m.content ?? ''),
    ).length;
    if (nudged >= this.recoverAfter) {
      const text = 'Changed approach and finished.';
      yield { type: 'text', text };
      yield { type: 'done', response: { text, toolCalls: [], stopReason: 'done' } };
      return;
    }
    const call = READ(1);   // identical every turn — that is the stall
    yield { type: 'tool_start', name: call.name, id: call.id };
    yield { type: 'tool_end', call };
    yield {
      type: 'done',
      response: {
        text: '', toolCalls: [call], stopReason: 'tools',
        usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
      },
    };
  }
}

/** Makes a *different* call every turn, so the stall detector never fires and
 *  only the turn ceiling can stop it. */
class BusyProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  turns = 0;

  async complete(): Promise<LLMResponse> {
    return { text: '- distilled fact', toolCalls: [], stopReason: 'done' };
  }

  async *stream(): AsyncGenerator<StreamChunk> {
    this.turns++;
    const call = READ(this.turns, `f${this.turns}.json`);
    yield { type: 'tool_start', name: call.name, id: call.id };
    yield { type: 'tool_end', call };
    yield {
      type: 'done',
      response: {
        text: '', toolCalls: [call], stopReason: 'tools',
        usage: { inputTokens: 500, outputTokens: 10, cachedTokens: 0 },
      },
    };
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-loop-persist-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  vi.stubEnv('AURA_SESSION_BUDGET', '');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const run = async (provider: LLMProvider, opts: Record<string, unknown> = {}) => {
  const ctx = await loadProjectContext(tmpDir);
  return runAgentLoop({
    provider, task: 'do the thing', context: ctx,
    permissions: new PermissionSystem('auto'), display: noopDisplay,
    disableSpawn: true, checkpoints: false, maxTurns: 4,
    ...opts,
  });
};

describe('the turn ceiling', () => {
  it('still stops a run that was given no budget', async () => {
    // Nothing else is counting in that case, so the cap must stay hard.
    const provider = new BusyProvider();
    const result = await run(provider);
    expect(result.turns).toBe(4);
    expect(result.summary).toMatch(/cap: 4/);
  });

  it('keeps going past the cap while the budget has token headroom', async () => {
    const provider = new BusyProvider();
    const result = await run(provider, {
      budget: new SessionBudget({ maxInputTokens: 6000 }),
    });
    // Without the extension this stops dead at 4.
    expect(result.turns).toBeGreaterThan(4);
  });

  it('stops when the budget runs out, and says so', async () => {
    // The budget replaces the turn cap as the thing that ends the run — so it
    // has to actually end it, or "auto-continue" means "never stops".
    const provider = new BusyProvider();
    const result = await run(provider, {
      budget: new SessionBudget({ maxInputTokens: 6000 }),
    });
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/budget|token/i);
    expect(provider.turns).toBeLessThan(40);
  });

  it('extends in whole windows, not one turn at a time', async () => {
    // Bumping by a single turn would re-announce the ceiling on every turn.
    const warnings: string[] = [];
    const display = new Proxy({} as Display, {
      get: (_t, k) => (k === 'warning' ? (m: string) => warnings.push(m) : () => {}),
    });
    const result = await run(new BusyProvider(), {
      maxTurns: 3, display,
      budget: new SessionBudget({ maxInputTokens: 6000 }),
    });

    const extensions = warnings.filter(w => /continuing to \d+/.test(w));
    expect(extensions.length).toBeGreaterThan(0);
    // One announcement per window of 3, never one per turn.
    expect(extensions.length).toBeLessThan(result.turns / 2);
    expect(extensions[0]).toMatch(/continuing to 6/);
  });
});

describe('the stall detector', () => {
  it('tells the model to change approach instead of stopping', async () => {
    const result = await run(new StuckProvider(), {
      maxTurns: 30,
      budget: new SessionBudget({ maxInputTokens: 100_000 }),
    });
    const nudge = result.history.find(
      m => m.role === 'user' && /change approach/i.test(m.content ?? ''),
    );
    expect(nudge).toBeDefined();
    // The correction has to be specific about the loop, or the model reads it
    // as generic encouragement and repeats the call.
    expect(nudge!.content).toMatch(/identical tool call/i);
    expect(nudge!.content).toMatch(/DIFFERENT action/);
  });

  it('lets the run finish when the correction works', async () => {
    // This is the whole point: a stall used to be fatal, and most are not.
    const result = await run(new StuckProvider(1), {
      maxTurns: 30,
      budget: new SessionBudget({ maxInputTokens: 100_000 }),
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Changed approach and finished.');
  });

  it('gives up after three ignored corrections', async () => {
    const result = await run(new StuckProvider(), {
      maxTurns: 60,
      budget: new SessionBudget({ maxInputTokens: 100_000 }),
    });
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/stalled/i);
    expect(result.summary).toMatch(/3 corrections ignored/);
  });

  it('spends its three nudges on three separate stalls, not one', async () => {
    // The signatures that triggered a stall are still the tail of the list, so
    // without clearing them the next turn re-fires immediately and all three
    // corrections are burned before the model ever gets to answer one.
    const result = await run(new StuckProvider(), {
      maxTurns: 60,
      budget: new SessionBudget({ maxInputTokens: 100_000 }),
    });
    const nudges = result.history.filter(
      m => m.role === 'user' && /change approach/i.test(m.content ?? ''),
    );
    expect(nudges).toHaveLength(3);
    // Three stalls at threshold 3 means the model got to reply between them.
    expect(result.turns).toBeGreaterThanOrEqual(9);
  });
});

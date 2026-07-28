import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same stubbing rationale as loop.test.ts: keep the compaction summary path
// off the network and give the fake model a predictable window.
vi.mock('../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 1_000_000 : mod.getContextWindow(m)),
    createProvider: () => ({
      name: 'stub-summary-provider',
      model: 'stub',
      supportsTools: false,
      complete: async () => ({ text: '- fact', toolCalls: [], stopReason: 'done' as const }),
      stream: async function* () { /* unused */ },
    }),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCoderConversation } from '../src/agent/coder-conversation.js';
import { SessionBudget, DEFAULT_MAX_INPUT_TOKENS } from '../src/agent/session-budget.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type { LLMProvider, LLMResponse, HistoryMessage, StreamChunk } from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

const noopDisplay: Display = {
  agentThinking: () => {}, streamText: () => {}, streamEnd: () => {},
  toolStart: () => {}, toolCall: () => {}, toolResult: () => {}, toolBlocked: () => {},
  warning: () => {}, success: () => {}, error: () => {}, header: () => {}, summary: () => {},
};

/**
 * Per-call input tokens taken from the real session
 * (_mnt_bigdata_aura_aura-code/3906d0f9-mrzqv22e.json): 7,245 on turn 1 rising
 * linearly to 57,073 on turn 85. The growth — not the turn count — is what
 * drives spend, so the fixture reproduces it rather than using a flat
 * per-turn figure.
 *
 * That session recorded zero cache hits, which is why this fixture reports
 * none either. The zero was a client-side logging gap (Zhipu's cache fields
 * went unread until 043fdbc), not an absence of caching — so treat the raw
 * totals here as a worst case, not as what that run actually billed.
 */
const REAL_TURN_1 = 7_245;
const REAL_TURN_85 = 57_073;
const REAL_TOTAL_INPUT = 2_221_012;
function inputTokensForTurn(cumulativeTurn: number): number {
  const t = Math.min(cumulativeTurn, 85);
  return Math.round(REAL_TURN_1 + ((REAL_TURN_85 - REAL_TURN_1) * (t - 1)) / 84);
}

/** Emits distinct tool calls forever, with usage matching the real curve.
 *  Distinct on purpose: the real session had 105 unique calls and never
 *  tripped stall detection, so only a budget can stop this. */
class GrowingProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  /** Cumulative across every stream() call, i.e. across conversation segments. */
  callCount = 0;
  totalInput = 0;

  async complete(): Promise<LLMResponse> {
    return { text: '- distilled fact', toolCalls: [], stopReason: 'done' };
  }

  async *stream(_system: string, _history: HistoryMessage[]): AsyncGenerator<StreamChunk> {
    this.callCount++;
    const inputTokens = inputTokensForTurn(this.callCount);
    this.totalInput += inputTokens;
    const call = { id: `c${this.callCount}`, name: 'read_file', input: { path: `f${this.callCount}.json` } };
    const response = {
      text: '', toolCalls: [call], stopReason: 'tools' as const,
      usage: { inputTokens, outputTokens: 50, cachedTokens: 0, cacheCreationTokens: 0 },
    };
    yield { type: 'tool_start', name: call.name, id: call.id };
    yield { type: 'tool_end', call };
    yield { type: 'done', response: response as LLMResponse };
  }
}

/** Feeds a fixed list of user messages, then EOF — one message per segment. */
function scriptedReader(lines: string[]) {
  let i = 0;
  return { nextLine: async () => (i < lines.length ? lines[i++] : null), close: () => {} };
}

const devNull = { write: () => true } as unknown as NodeJS.WritableStream;

describe('SessionBudget', () => {
  // The default-ceiling assertions below read the real environment through
  // maxInputTokensFromEnv, so a developer with AURA_SESSION_BUDGET exported in
  // their shell would otherwise fail this suite.
  beforeEach(() => { vi.stubEnv('AURA_SESSION_BUDGET', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('binds on cumulative turns', () => {
    const b = new SessionBudget({ maxTurns: 3 });
    expect(b.exhausted()).toBeNull();
    b.recordTurn(); b.recordTurn();
    expect(b.exhausted()).toBeNull();
    b.recordTurn();
    expect(b.exhausted()).toMatchObject({ kind: 'turns', used: 3, limit: 3 });
  });

  it('binds on cumulative input tokens even when turns are plentiful', () => {
    const b = new SessionBudget({ maxTurns: 1000, maxInputTokens: 100_000 });
    b.recordCall(60_000);
    expect(b.exhausted()).toBeNull();
    b.recordCall(60_000);
    expect(b.exhausted()).toMatchObject({ kind: 'tokens' });
  });

  it('counts input net of cache hits, so a cached session travels further', () => {
    const cold = new SessionBudget({ maxInputTokens: 100_000 });
    const warm = new SessionBudget({ maxInputTokens: 100_000 });
    for (let i = 0; i < 10; i++) {
      cold.recordCall(50_000, 0);
      warm.recordCall(50_000, 45_000); // 90% hit rate, as measured on glm-5.2
    }
    // Identical raw prompt volume (500k each), very different billed spend.
    expect(cold.inputTokensUsed).toBe(500_000);
    expect(warm.inputTokensUsed).toBe(50_000);
    expect(cold.exhausted()).toMatchObject({ kind: 'tokens' });
    expect(warm.exhausted()).toBeNull();
  });

  it('never counts backwards if a provider over-reports cache hits', () => {
    const b = new SessionBudget({ maxInputTokens: 100_000 });
    b.recordCall(1_000, 5_000);
    expect(b.inputTokensUsed).toBe(0);
  });

  it('defaults the token ceiling and leaves turns unbounded when unset', () => {
    const b = new SessionBudget();
    expect(b.maxTurns).toBe(Infinity);
    expect(b.maxInputTokens).toBe(DEFAULT_MAX_INPUT_TOKENS);
  });
});

describe('multi-segment coder conversation — the 2.2M session shape', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // Three user messages = three runAgentLoop invocations, exactly like the
  // real session (its turn counter ran to 80, then restarted at 1, 2, 3).
  // Each must read as a coding task: a short non-technical line instead
  // triggers the "back to just talking?" offer and never runs (see CODEY_RE
  // in coder-conversation.ts).
  const THREE_SEGMENTS = [
    'healthcheck the project',
    'now check the build',
    'and run the render views check',
  ];

  it('per-segment maxTurns alone does NOT bound the conversation (the bug)', async () => {
    const provider = new GrowingProvider();
    const ctx = await loadProjectContext(tmpDir);
    // No shared budget: each segment gets its own fresh 30-turn allowance.
    await runCoderConversation({
      provider, ctx, permissions: new PermissionSystem('auto'), display: noopDisplay,
      reader: scriptedReader(THREE_SEGMENTS), output: devNull, interactive: false,
      maxTurns: 30,
      budget: new SessionBudget({ maxTurns: Infinity, maxInputTokens: Infinity }),
    });
    // 3 segments x 30 turns — the per-invocation cap never accumulates.
    expect(provider.callCount).toBe(90);
    expect(provider.callCount).toBeGreaterThan(85); // worse than the real run
  });

  it('a shared budget stops the same conversation at the cumulative cap', async () => {
    const provider = new GrowingProvider();
    const ctx = await loadProjectContext(tmpDir);
    await runCoderConversation({
      provider, ctx, permissions: new PermissionSystem('auto'), display: noopDisplay,
      reader: scriptedReader(THREE_SEGMENTS), output: devNull, interactive: false,
      maxTurns: 30,
    });
    // Cumulative across all three segments, not 30 per segment.
    expect(provider.callCount).toBe(30);
    // The run the fix is measured against: 2.22M input tokens over 85 turns.
    expect(provider.totalInput).toBeLessThan(REAL_TOTAL_INPUT / 4);
  });

  it('the token ceiling stops a conversation whose turns are few but huge', async () => {
    const provider = new GrowingProvider();
    const ctx = await loadProjectContext(tmpDir);
    await runCoderConversation({
      provider, ctx, permissions: new PermissionSystem('auto'), display: noopDisplay,
      reader: scriptedReader(THREE_SEGMENTS), output: devNull, interactive: false,
      // Turns deliberately unbounded — only the token ceiling can stop this.
      budget: new SessionBudget({ maxTurns: Infinity, maxInputTokens: 500_000 }),
    });
    expect(provider.totalInput).toBeGreaterThanOrEqual(500_000);
    // Stopped promptly after crossing, not allowed to run to the real 2.22M.
    expect(provider.totalInput).toBeLessThan(600_000);
    expect(provider.callCount).toBeLessThan(85);
  });
});

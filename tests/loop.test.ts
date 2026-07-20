import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Give the fake model a tiny context window so compaction triggers with
// test-sized histories; every other model resolves as usual.
//
// createProvider is stubbed too: the tiered-context summary path
// (tiered-context.ts's getSummaryProvider) calls the real createProvider with
// whatever AURA_CONTEXT_SUMMARY_MODEL/DeepSeek/AURA_FALLBACK_MODEL resolves
// to. Without this stub, these tests' behavior depends on ambient shell env
// (DEEPSEEK_API_KEY, AURA_CONTEXT_STRATEGY) — a real key routes to a live
// network call (slow, non-hermetic, times out with no egress); no key 401s
// against the OpenAI-compatible default. Stubbing it makes the summary path
// fast and deterministic regardless of what's exported in the shell.
vi.mock('../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 10_000 : mod.getContextWindow(m)),
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
import { runAgentLoop, type TokenUsage } from '../src/agent/loop.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, ToolDefinition, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

const noopDisplay: Display = {
  agentThinking: () => {},
  streamText: () => {},
  streamEnd: () => {},
  toolStart: () => {},
  toolCall: () => {},
  toolResult: () => {},
  toolBlocked: () => {},
  warning: () => {},
  success: () => {},
  error: () => {},
  header: () => {},
  summary: () => {},
};

class FakeProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  responses: LLMResponse[];
  calls: HistoryMessage[] = [];
  /** Text returned by complete() — used by the loop's own retry path AND by
   *  generational-flush's distillText, which calls complete() directly
   *  rather than stream(). Kept off the stream() queue so a mid-run flush
   *  doesn't consume a response meant for the next stream() turn. */
  completeText = '- distilled fact';

  constructor(responses: LLMResponse[]) { this.responses = responses; }

  async complete(): Promise<LLMResponse> {
    return { text: this.completeText, toolCalls: [], stopReason: 'done' };
  }

  async *stream(_system: string, history: HistoryMessage[]): AsyncGenerator<StreamChunk> {
    this.calls.push(...history);
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses queued');
    if (next.text) yield { type: 'text', text: next.text };
    for (const tc of next.toolCalls) {
      yield { type: 'tool_start', name: tc.name, id: tc.id };
      yield { type: 'tool_end', call: tc };
    }
    yield { type: 'done', response: next };
  }
}

describe('runAgentLoop', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-loop-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    // These tests assert on the default compactor's recap/flush markers —
    // pin the strategy so an ambient AURA_CONTEXT_STRATEGY=tiered in the
    // shell can't silently redirect compaction to the tiered fact-log path
    // and break those assertions.
    vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    vi.unstubAllEnvs();
  });

  it('returns success when model emits text only', async () => {
    const provider = new FakeProvider([
      { text: 'all done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('all done');
    expect(result.turns).toBe(1);
  });

  it('retries empty responses up to 3x before giving up', async () => {
    // 4 empty responses — the loop retries the first 3, then accepts the 4th
    const provider = new FakeProvider([
      { text: '', toolCalls: [], stopReason: 'done' },
      { text: '', toolCalls: [], stopReason: 'done' },
      { text: '', toolCalls: [], stopReason: 'done' },
      { text: '', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    // After 4 attempts the loop gives up — the provider clearly can't respond
    expect(result.success).toBe(false);
    expect(result.summary).toContain('empty response');
    expect(result.turns).toBe(4);
  });

  it('executes a tool call and feeds the result back', async () => {
    const provider = new FakeProvider([
      {
        text: '',
        toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'package.json' } }],
        stopReason: 'tools',
      },
      { text: 'finished', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(1);
    expect(result.turns).toBe(2);
  });

  it('handles provider errors gracefully (returns error result, does not throw)', async () => {
    const provider = new FakeProvider([]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/Provider error/);
  });

  it('stops cleanly on max turns', async () => {
    const responses = Array.from({ length: 100 }, () => ({
      text: '',
      toolCalls: [{ id: 'c', name: 'read_file', input: { path: 'package.json' } }],
      stopReason: 'tools' as const,
    }));
    const provider = new FakeProvider(responses);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay, maxTurns: 3,
    });
    expect(result.success).toBe(false);
    expect(result.turns).toBe(3);
  });

  it('stops on a two-call cycle stall (A B A B A B)', async () => {
    const a = { id: 'c', name: 'read_file', input: { path: 'package.json' } };
    const b = { id: 'c', name: 'read_file', input: { path: 'other.json' } };
    const responses = Array.from({ length: 20 }, (_, i) => ({
      text: '',
      toolCalls: [i % 2 === 0 ? a : b],
      stopReason: 'tools' as const,
    }));
    const provider = new FakeProvider(responses);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx, // single-file: stallThreshold 3
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    expect(result.success).toBe(false);
    expect(result.turns).toBe(6); // 3 full A-B cycles
    expect(result.summary).toMatch(/cycling/);
  });

  it('widens the single-file budget once instead of dying at the ceiling', async () => {
    // 33 productive (non-repeating) tool turns, then done. A single-file
    // profile caps at 30, so without widening this would fail at turn 30.
    const responses: LLMResponse[] = Array.from({ length: 33 }, (_, i) => ({
      text: '',
      toolCalls: [{ id: `c${i}`, name: 'read_file', input: { path: `f${i}.json` } }],
      stopReason: 'tools' as const,
    }));
    responses.push({ text: 'made it', toolCalls: [], stopReason: 'done' });
    const provider = new FakeProvider(responses);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('made it');
    expect(result.turns).toBe(34);
  });

  it('compacts history mid-run and keeps the executive digest + full toolCallLog', async () => {
    // ~2,900 tokens of prose per turn (3.5 chars/token fallback) against a
    // 10k window (mocked above): the 75% trigger fires after ~3 turns.
    const fat = 'y'.repeat(10_000);
    const responses: LLMResponse[] = Array.from({ length: 5 }, (_, i) => ({
      text: fat,
      toolCalls: [{ id: `c${i}`, name: 'write_file', input: { path: `f${i}.ts`, content: 'x' } }],
      stopReason: 'tools' as const,
    }));
    responses.push({ text: 'made it', toolCalls: [], stopReason: 'done' });
    const provider = new FakeProvider(responses);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });

    expect(result.success).toBe(true);
    // Compaction happened: some later provider call saw the recap message,
    // carrying the executive digest of already-executed mutations.
    const recaps = provider.calls.filter(
      m => m.role === 'assistant' && m.content.includes('[Earlier conversation compacted'),
    );
    expect(recaps.length).toBeGreaterThan(0);
    expect(recaps.some(m => (m as { content: string }).content.includes('do not repeat'))).toBe(true);
    expect(recaps.some(m => (m as { content: string }).content.includes('write_file f0.ts'))).toBe(true);
    // The verify-layer contract holds: toolCallLog still has every call.
    expect(result.toolCallLog.filter(c => c.name === 'write_file').length).toBe(5);
  });

  it('rolls over to a fresh context window after enough recap generations, flushing to the dream store', async () => {
    // Ladder is [0.55, 0.70, 0.85] against the mocked 10k window; each fat
    // turn (~2,900 tokens) pushes the estimate well past whichever rung is
    // current, so this should compact repeatedly, escalate generations, and
    // eventually roll over (ROLLOVER_AT_GENERATION = 3) rather than produce
    // a 4th lossy in-place recap.
    const fat = 'y'.repeat(10_000);
    const responses: LLMResponse[] = Array.from({ length: 14 }, (_, i) => ({
      text: fat,
      toolCalls: [{ id: `c${i}`, name: 'write_file', input: { path: `f${i}.ts`, content: 'x' } }],
      stopReason: 'tools' as const,
    }));
    responses.push({ text: 'made it', toolCalls: [], stopReason: 'done' });
    const provider = new FakeProvider(responses);
    provider.completeText = '- distilled: refactored the parser across many files';
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });

    expect(result.success).toBe(true);

    // A rollover happened: some later stream() call saw a flush pointer
    // instead of an ever-growing recap, and the flush file actually landed
    // in the project's dream store (same mechanism runDream/:dream use).
    const flushPointers = provider.calls.filter(
      m => m.role === 'assistant' && m.content.includes('flushed to memory'),
    );
    expect(flushPointers.length).toBeGreaterThan(0);

    const dreamsDir = path.join(tmpDir, 'dreams');
    expect(fs.existsSync(dreamsDir)).toBe(true);
    const flushFiles = fs.readdirSync(dreamsDir).filter(f => f.includes('-flush-'));
    expect(flushFiles.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dreamsDir, flushFiles[0]), 'utf8')).toContain('refactored the parser');

    // No stale recap text from before the flush survives in-context —
    // the pointer replaced it, not a further recompaction of it.
    const laterCalls = provider.calls.slice(-20);
    expect(laterCalls.some(m => m.role === 'assistant' && m.content.startsWith('[Earlier conversation compacted (gen 4)'))).toBe(false);

    // Verify layer contract holds: every write_file call is still logged.
    expect(result.toolCallLog.filter(c => c.name === 'write_file').length).toBe(14);
  });

  it('never widens past an explicit maxTurns override', async () => {
    const responses = Array.from({ length: 20 }, (_, i) => ({
      text: '',
      toolCalls: [{ id: `c${i}`, name: 'read_file', input: { path: `f${i}.json` } }],
      stopReason: 'tools' as const,
    }));
    const provider = new FakeProvider(responses);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay, maxTurns: 5,
    });
    expect(result.success).toBe(false);
    expect(result.turns).toBe(5);
  });
});

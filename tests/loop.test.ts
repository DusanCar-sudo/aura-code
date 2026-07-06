import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Give the fake model a tiny context window so compaction triggers with
// test-sized histories; every other model resolves as usual.
vi.mock('../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 10_000 : mod.getContextWindow(m)),
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

  constructor(responses: LLMResponse[]) { this.responses = responses; }

  async complete(): Promise<LLMResponse> {
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses queued');
    return next;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-loop-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

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

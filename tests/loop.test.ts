import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('treats empty response as done (no infinite loop)', async () => {
    const provider = new FakeProvider([
      { text: '', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1);
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
});

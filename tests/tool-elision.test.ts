import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same factory stub as loop.test.ts — keeps the compaction/summary path
// hermetic regardless of ambient shell env.
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
import { elideToolCallArgs, elideGoogleParts, ELIDE_STRING_AFTER_CHARS } from '../src/agent/tool-elision.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type { ToolCall, LLMProvider, HistoryMessage, StreamChunk, LLMResponse } from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

describe('elideToolCallArgs', () => {
  it('keeps small arguments verbatim', () => {
    const call: ToolCall = { id: 'c', name: 'edit_file', input: { path: 'a.ts', find: 'old', replace: 'new' } };
    expect(elideToolCallArgs(call).input).toEqual(call.input);
  });

  it('stubs a large write_file content payload', () => {
    const big = 'A'.repeat(ELIDE_STRING_AFTER_CHARS + 1000);
    const call: ToolCall = { id: 'c', name: 'write_file', input: { path: 'src/out.ts', content: big } };
    const elided = elideToolCallArgs(call).input as Record<string, unknown>;
    expect(elided.path).toBe('src/out.ts'); // identity args survive
    expect(elided.content).toContain('chars omitted');
    expect(String(elided.content).length).toBeLessThan(200);
    expect(String(elided.content)).not.toContain('AAAA');
  });

  it('keeps a prefix of edit_file.find and stubs replace', () => {
    const find = 'line one\n' + 'x'.repeat(ELIDE_STRING_AFTER_CHARS + 500);
    const replace = 'R'.repeat(ELIDE_STRING_AFTER_CHARS + 100);
    const call: ToolCall = { id: 'c', name: 'edit_file', input: { path: 'a.ts', find, replace } };
    const elided = elideToolCallArgs(call).input as Record<string, unknown>;
    expect(String(elided.find)).toContain('line one');
    expect(String(elided.find)).toContain('chars omitted');
    expect(String(elided.find).length).toBeLessThan(1000);
    expect(String(elided.replace)).toContain('chars omitted');
    expect(String(elided.replace)).not.toContain('RRR');
  });

  it('recurses into nested objects and arrays', () => {
    const big = 'B'.repeat(ELIDE_STRING_AFTER_CHARS + 10);
    const call: ToolCall = {
      id: 'c', name: 'telegram',
      input: { chat_id: 1, text: 'hello', payload: { nested: [big, 'small'] } },
    };
    const elided = elideToolCallArgs(call).input as Record<string, unknown>;
    expect(elided.text).toBe('hello');
    const payload = elided.payload as { nested: unknown[] };
    expect(String(payload.nested[0])).toContain('chars omitted');
    expect(payload.nested[1]).toBe('small');
  });

  it('never elides spawn_task arguments (the prompt is the payload)', () => {
    const big = 'S'.repeat(ELIDE_STRING_AFTER_CHARS + 100);
    const call: ToolCall = { id: 'c', name: 'spawn_task', input: { prompt: big } };
    expect(elideToolCallArgs(call).input).toEqual(call.input);
  });

  it('elides functionCall args in googleParts (Gemini raw parts)', () => {
    const big = 'G'.repeat(ELIDE_STRING_AFTER_CHARS + 10);
    const parts = [
      { text: 'hello' },
      { functionCall: { name: 'write_file', args: { path: 'a.txt', content: big } } },
    ];
    const elided = elideGoogleParts(parts) as Array<{ functionCall?: { args: Record<string, unknown> } }>;
    expect(elided[0]).toEqual({ text: 'hello' });
    expect(String(elided[1].functionCall!.args.content)).toContain('chars omitted');
    expect(elided[1].functionCall!.args.path).toBe('a.txt');
  });

  it('does not mutate the original call', () => {
    const big = 'C'.repeat(ELIDE_STRING_AFTER_CHARS + 10);
    const call: ToolCall = { id: 'c', name: 'write_file', input: { path: 'a.ts', content: big } };
    elideToolCallArgs(call);
    expect(call.input.content).toBe(big);
  });
});

describe('tool-call arg elision in the loop', () => {
  const noopDisplay: Display = {
    agentThinking: () => {}, streamText: () => {}, streamEnd: () => {},
    toolStart: () => {}, toolCall: () => {}, toolResult: () => {},
    toolBlocked: () => {}, warning: () => {}, success: () => {},
    error: () => {}, header: () => {}, summary: () => {},
  };

  class FakeProvider implements LLMProvider {
    name = 'Fake';
    model = 'fake-model';
    supportsTools = true;
    responses: LLMResponse[];
    completeText = '- distilled fact';
    constructor(responses: LLMResponse[]) { this.responses = responses; }
    async complete(): Promise<LLMResponse> {
      return { text: this.completeText, toolCalls: [], stopReason: 'done' };
    }
    async *stream(_system: string, _history: HistoryMessage[]): AsyncGenerator<StreamChunk> {
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

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-elide-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    vi.unstubAllEnvs();
  });

  it('elides large args in history but keeps them in the tool call log', async () => {
    const big = 'X'.repeat(ELIDE_STRING_AFTER_CHARS + 1000);
    const provider = new FakeProvider([
      {
        text: '', stopReason: 'tools',
        toolCalls: [{ id: 'c1', name: 'write_file', input: { path: 'out.txt', content: big } }],
      },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });

    // History copy is elided.
    const histCall = result.history.find(
      (m): m is HistoryMessage & { toolCalls: ToolCall[] } =>
        m.role === 'assistant' && !!m.toolCalls && m.toolCalls.length > 0,
    );
    expect(histCall).toBeDefined();
    expect(histCall!.toolCalls![0].input.content).toContain('chars omitted');
    expect(String(histCall!.toolCalls![0].input.content)).not.toContain('XXXX');

    // The live log keeps the full payload for verification/display.
    expect(result.toolCallLog[0].input.content).toBe(big);
  });

  it('keeps small write payloads verbatim in history', async () => {
    const provider = new FakeProvider([
      {
        text: '', stopReason: 'tools',
        toolCalls: [{ id: 'c1', name: 'write_file', input: { path: 'out.txt', content: 'small' } }],
      },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const histCall = result.history.find(
      (m): m is HistoryMessage & { toolCalls: ToolCall[] } =>
        m.role === 'assistant' && !!m.toolCalls && m.toolCalls.length > 0,
    );
    expect(histCall!.toolCalls![0].input.content).toBe('small');
  });
});

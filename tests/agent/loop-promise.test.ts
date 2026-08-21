import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 200_000 : mod.getContextWindow(m)),
    createProvider: () => ({
      name: 'stub-summary-provider', model: 'stub', supportsTools: false,
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
import { runAgentLoop } from '../../src/agent/loop.js';
import { PermissionSystem } from '../../src/safety/permissions.js';
import { loadProjectContext } from '../../src/agent/context.js';
import type { LLMProvider, StreamChunk, LLMResponse } from '../../src/providers/types.js';
import type { Display } from '../../src/cli/display.js';

/**
 * Reproduces the reported failure: the run ends "1 turn · 0 tool call" with the
 * model announcing work it never did, and the loop reports it as success. The
 * user typed "make it now" and then "finish fast" and got another promise each
 * time, because from the loop's side nothing had gone wrong.
 */

const noopDisplay = new Proxy({} as Display, { get: () => () => {} });

class ScriptedProvider implements LLMProvider {
  name = 'Fake'; model = 'fake-model'; supportsTools = true;
  private last: LLMResponse | undefined;
  constructor(private queue: LLMResponse[]) {}
  async complete(): Promise<LLMResponse> {
    return { text: '- distilled fact', toolCalls: [], stopReason: 'done' };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    // Repeat the final scripted response forever — a model that ignores the
    // nudge keeps saying the same thing, which is the case under test.
    const next = this.queue.shift() ?? this.last;
    if (!next) throw new Error('queue empty');
    this.last = next;
    if (next.text) yield { type: 'text', text: next.text };
    for (const tc of next.toolCalls) {
      yield { type: 'tool_start', name: tc.name, id: tc.id };
      yield { type: 'tool_end', call: tc };
    }
    yield { type: 'done', response: { ...next, usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } } };
  }
}

const promise = (text: string): LLMResponse => ({ text, toolCalls: [], stopReason: 'done' });
const READ: LLMResponse = {
  text: '', stopReason: 'tools',
  toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'package.json' } }],
};

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-promise-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  vi.stubEnv('AURA_SESSION_BUDGET', '');
});
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const run = async (queue: LLMResponse[]) => {
  const ctx = await loadProjectContext(tmpDir);
  return runAgentLoop({
    provider: new ScriptedProvider(queue), task: 'add 7 feature cards', context: ctx,
    permissions: new PermissionSystem('auto'), display: noopDisplay,
    disableSpawn: true, checkpoints: false, maxTurns: 10,
  });
};

describe('a reply that promises work but calls no tool', () => {
  it('does not end the run as a success', async () => {
    const result = await run([promise('Adding your 7 feature cards now — one quick edit.')]);
    expect(result.success).toBe(false);
  });

  it('tells the model to act instead of narrating', async () => {
    const result = await run([promise('Building your 7 feature cards now.')]);
    const nudge = result.history.find(
      m => m.role === 'user' && /did not call any tool/i.test(m.content ?? ''),
    );
    expect(nudge).toBeDefined();
    expect(nudge!.content).toMatch(/write_file or\s+edit_file/);
  });

  it('recovers when the nudge works', async () => {
    // The whole point: one push and the run does the job it announced.
    const result = await run([
      promise('Adding your 7 feature cards now.'),
      READ,
      promise('Added the 7 feature cards and verified they render.'),
    ]);
    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(1);
  });

  it('gives up after two ignored nudges rather than looping forever', async () => {
    const result = await run([promise('Adding your 7 feature cards now.')]);
    const nudges = result.history.filter(
      m => m.role === 'user' && /did not call any tool/i.test(m.content ?? ''),
    );
    expect(nudges).toHaveLength(2);
    expect(result.success).toBe(false);
  });
});

describe('replies the guard must leave alone', () => {
  it('a prose summary after real tool work is a success', async () => {
    const result = await run([READ, promise('Added the cards to index.html.')]);
    expect(result.success).toBe(true);
    expect(result.history.some(
      m => m.role === 'user' && /did not call any tool/i.test(m.content ?? ''),
    )).toBe(false);
  });

  it('an answer with no tool calls is still a success', async () => {
    // Answering IS the work for a question — this must not be nudged, or every
    // question costs an extra turn and a re-run.
    const result = await run([promise(
      'The cache misses on restart because the key includes the process id, so each '
      + 'boot gets a fresh namespace and nothing from the previous run is read back.',
    )]);
    expect(result.success).toBe(true);
  });

  it('a question back to the user is a success', async () => {
    const result = await run([promise('Which of the two config files should I edit?')]);
    expect(result.success).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 200_000 : mod.getContextWindow(m)),
    createProvider: () => ({
      name: 'stub', model: 'stub', supportsTools: false,
      complete: async () => ({ text: '-', toolCalls: [], stopReason: 'done' as const }),
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done', response: { text: '', toolCalls: [], stopReason: 'done' } };
      },
    }),
  };
});

// A tool that returns the object form — this is what `computer` will do.
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
vi.mock('../../src/tools/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/tools/index.js')>();
  return {
    ...mod,
    executeTool: async (name: string) =>
      name === 'read_file'
        ? { text: 'screen 2259x2471', images: [PNG] }
        : 'plain text result',
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
 * A screenshot is the *result of a tool call*, so it has to travel back through
 * the tool-result channel. Before this, ToolResult was text-only and the only
 * way to return a picture was base64 in `content` — where the model receives a
 * megabyte of characters rather than an image.
 */

const noopDisplay = new Proxy({} as Display, { get: () => () => {} });

class Once implements LLMProvider {
  name = 'Fake'; model = 'fake-model'; supportsTools = true;
  private used = false;
  async complete(): Promise<LLMResponse> {
    return { text: '-', toolCalls: [], stopReason: 'done' };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    if (this.used) {
      yield { type: 'text', text: 'saw it' };
      yield { type: 'done', response: { text: 'saw it', toolCalls: [], stopReason: 'done' } };
      return;
    }
    this.used = true;
    const call = { id: 'c1', name: 'read_file', input: { path: 'package.json' } };
    yield { type: 'tool_start', name: call.name, id: call.id };
    yield { type: 'tool_end', call };
    yield { type: 'done', response: { text: '', toolCalls: [call], stopReason: 'tools' } };
  }
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-toolimg-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"t"}');
  vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  vi.stubEnv('AURA_SESSION_BUDGET', '');
});
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('a tool that returns images', () => {
  it('gets them into the tool result, and its text stays text', async () => {
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider: new Once(), task: 'look', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      disableSpawn: true, checkpoints: false, maxTurns: 5,
    });

    const tr = result.history.find(m => m.role === 'tool_result');
    expect(tr).toBeDefined();
    const r = (tr as { results: { content: string; images?: string[] }[] }).results[0];
    expect(r.images).toEqual([PNG]);
    // The base64 must NOT have been folded into the text channel — that is the
    // failure mode this whole change exists to remove.
    expect(r.content).toBe('screen 2259x2471');
    expect(r.content).not.toContain('base64');
  });
});

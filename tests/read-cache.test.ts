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
import { runAgentLoop } from '../src/agent/loop.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

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

/** Pull the tool_result contents out of a finished run's history, in order. */
function toolResultTexts(history: HistoryMessage[]): string[] {
  const out: string[] = [];
  for (const m of history) {
    if (m.role === 'tool_result') for (const r of m.results) out.push(r.content);
  }
  return out;
}

const CACHE_NOTE = 'Result omitted';

describe('redundant-read cache', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-readcache-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'ORIGINAL_CONTENT');
    vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    vi.unstubAllEnvs();
  });

  it('elides the second identical read instead of re-sending the content', async () => {
    const read = { id: 'c', name: 'read_file', input: { path: 'data.txt' } };
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ ...read, id: 'c1' }], stopReason: 'tools' },
      { text: '', toolCalls: [{ ...read, id: 'c2' }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    expect(texts).toHaveLength(2);
    // First read returns real content.
    expect(texts[0]).toContain('ORIGINAL_CONTENT');
    // Second identical read is elided — this is the token saving.
    expect(texts[1]).toContain(CACHE_NOTE);
    expect(texts[1]).not.toContain('ORIGINAL_CONTENT');
  });

  it('does NOT serve stale content after a write — cache invalidates on mutation', async () => {
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'write_file', input: { path: 'data.txt', content: 'NEW_CONTENT' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c3', name: 'read_file', input: { path: 'data.txt' } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    const lastRead = texts[texts.length - 1];
    // Must reflect the write, and must NOT be a cache note.
    expect(lastRead).toContain('NEW_CONTENT');
    expect(lastRead).not.toContain(CACHE_NOTE);
    expect(lastRead).not.toContain('ORIGINAL_CONTENT');
  });

  it('treats different arguments as different calls (no false hit)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'OTHER_CONTENT');
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'other.txt' } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    expect(texts[0]).toContain('ORIGINAL_CONTENT');
    expect(texts[1]).toContain('OTHER_CONTENT');
    expect(texts[1]).not.toContain(CACHE_NOTE);
  });

  it('never caches a failed read — a retry after the file appears must succeed', async () => {
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'missing.txt' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'missing.txt' } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    // Both are real error results, not a cache note masking the error.
    expect(texts[1]).not.toContain(CACHE_NOTE);
  });

  it('elides a range read that is a subset of an earlier read still in context', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), lines);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt', start_line: 1, end_line: 10 } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'data.txt', start_line: 3, end_line: 5 } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    // First read returns the full range.
    expect(texts[0]).toContain('1: line 1');
    expect(texts[0]).toContain('10: line 10');
    // Subset read is elided — the lines are already in context.
    expect(texts[1]).toContain('within the earlier read');
    expect(texts[1]).not.toContain('3: line 3');
  });

  it('does not elide a read that extends beyond the earlier range', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), lines);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt', start_line: 1, end_line: 5 } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'data.txt', start_line: 2, end_line: 12 } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    // Wider read executes and returns real content, not an elision note.
    expect(texts[1]).not.toContain('within the earlier read');
    expect(texts[1]).toContain('2: line 2');
    expect(texts[1]).toContain('12: line 12');
  });

  it('a subset note does not clobber the coverage record — later subsets still elide', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), lines);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt', start_line: 1, end_line: 10 } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'data.txt', start_line: 3, end_line: 5 } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c3', name: 'read_file', input: { path: 'data.txt', start_line: 7, end_line: 8 } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    // Both subset reads are elided against the ORIGINAL 1–10 coverage.
    expect(texts[1]).toContain('within the earlier read');
    expect(texts[2]).toContain('within the earlier read');
    expect(texts[2]).not.toContain('7: line 7');
  });

  it('keeps cached reads of other files warm across a write (path-scoped invalidation)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'OTHER_CONTENT');
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'other.txt' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'write_file', input: { path: 'data.txt', content: 'NEW' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c3', name: 'read_file', input: { path: 'other.txt' } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    // The write to data.txt must not evict the cached read of other.txt —
    // the second read is elided, saving a re-read + re-send.
    expect(texts[0]).toContain('OTHER_CONTENT');
    expect(texts[2]).toContain(CACHE_NOTE);
    expect(texts[2]).not.toContain('OTHER_CONTENT');
  });

  it('a write to a file invalidates its own cached read even with a trailing slash variant', async () => {
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'write_file', input: { path: './data.txt', content: 'NEW_CONTENT' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c3', name: 'read_file', input: { path: 'data.txt' } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    expect(texts[2]).toContain('NEW_CONTENT');
    expect(texts[2]).not.toContain(CACHE_NOTE);
  });

  it('a write via a symlink alias invalidates the cached read through the link', async () => {
    fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'ORIGINAL_CONTENT');
    fs.symlinkSync(path.join(tmpDir, 'real.txt'), path.join(tmpDir, 'link.txt'));
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'link.txt' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'write_file', input: { path: 'real.txt', content: 'NEW_CONTENT' } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c3', name: 'read_file', input: { path: 'link.txt' } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    // String overlap can't see the alias — the realpath check must.
    expect(texts[2]).toContain('NEW_CONTENT');
    expect(texts[2]).not.toContain(CACHE_NOTE);
    expect(texts[2]).not.toContain('ORIGINAL_CONTENT');
  });

  it('does not elide a read of a line only partially present after char truncation', async () => {
    // ~200-char lines: the first full read (1–60) gets char-truncated mid-way
    // through line ~20, leaving the last numbered line only partially in
    // context. A later read of that exact line must NOT be elided.
    const longLine = (n: number) => `line ${n}: ` + 'x'.repeat(200);
    const lines = Array.from({ length: 60 }, (_, i) => longLine(i + 1)).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), lines);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data.txt', start_line: 1, end_line: 60 } }], stopReason: 'tools' },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'data.txt', start_line: 20, end_line: 20 } }], stopReason: 'tools' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'hi', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = toolResultTexts(result.history);
    expect(texts[0]).toContain('truncated');
    // Line 20 is only partially in context — the read must execute, not elide.
    expect(texts[1]).not.toContain('within the earlier read');
    expect(texts[1]).toContain('20: line 20:');
  });
});

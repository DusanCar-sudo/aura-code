import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HistoryMessage } from '../src/providers/types.js';

const WINDOW = 10_000; // same shape as compactor.test.ts: threshold@gen0 = 5,500

const completeMock = vi.fn(async (_system: string, _history: unknown, _tools: unknown) => ({
  text: '- did a thing\n- set a value',
  toolCalls: [],
  stopReason: 'done' as const,
}));

vi.mock('../src/providers/factory.js', () => ({
  getContextWindow: (model: string) => (model === 'test-model' ? WINDOW : undefined),
  createProvider: () => ({
    name: 'mock',
    model: 'mock-summary-model',
    supportsTools: false,
    complete: completeMock,
    stream: async function* () { /* unused in these tests */ },
  }),
}));

const { compactHistoryTiered } = await import('../src/agent/tiered-context.js');
const { computeTailBoundary } = await import('../src/agent/compactor.js');

const user = (content: string): HistoryMessage => ({ role: 'user', content });
const assistant = (content: string, toolCalls?: any[]): HistoryMessage =>
  ({ role: 'assistant', content, toolCalls });
const toolResult = (name: string, content: string): HistoryMessage =>
  ({ role: 'tool_result', results: [{ id: 't1', name, content, isError: false }] });

const text = (tokens: number) => 'x'.repeat(Math.ceil(tokens * 3.5));

function bigHistory(): HistoryMessage[] {
  const h: HistoryMessage[] = [user('original task: refactor the parser')];
  for (let i = 0; i < 5; i++) {
    h.push(user(`instruction ${i} ` + text(900)));
    h.push(assistant(`working on ${i}`, [{ id: `c${i}`, name: 'write_file', input: { path: `f${i}.ts` } }]));
    h.push(toolResult('write_file', text(900)));
  }
  return h;
}

function estimate(h: HistoryMessage[]): number {
  // Cheap local stand-in for estimateContextTokens (avoids importing the
  // real system-prompt-aware helper) — same char/3.5 fallback ratio.
  return h.reduce((sum, m) => sum + JSON.stringify(m).length / 3.5, 0);
}

describe('compactHistoryTiered', () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(() => {
    completeMock.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-context-test-'));
    sessionPath = path.join(tmpDir, 'session.json');
  });

  it('no-ops below threshold and never calls the summary model', async () => {
    const h = [user('task'), assistant('done')];
    const { compacted } = await compactHistoryTiered(h, estimate(h), 'test-model', sessionPath);
    expect(compacted).toBe(false);
    expect(completeMock).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionPath.replace('.json', '') + '.factlog.json')).toBe(false);
  });

  it('anchor (history[0]) is never touched', async () => {
    const h = bigHistory();
    const originalAnchor = { ...h[0] };
    await compactHistoryTiered(h, estimate(h), 'test-model', sessionPath);
    expect(h[0]).toEqual(originalAnchor);
  });

  it('tail boundary matches computeTailBoundary from compactor.ts', async () => {
    const h = bigHistory();
    const originalLength = h.length;
    const expectedKeepFrom = computeTailBoundary(h, WINDOW);
    const expectedTailSize = originalLength - expectedKeepFrom;

    const { compacted } = await compactHistoryTiered(h, estimate(h), 'test-model', sessionPath);
    expect(compacted).toBe(true);

    // [anchor, fact-log placeholder, ...verbatim tail]
    expect(h.length).toBe(2 + expectedTailSize);
    const tail = h.slice(2);
    expect(tail.length).toBe(expectedTailSize);
  });

  it('creates the sidecar fact-log file and populates it from the (mocked) summary model', async () => {
    const h = bigHistory();
    const { compacted, metrics } = await compactHistoryTiered(h, estimate(h), 'test-model', sessionPath);
    expect(compacted).toBe(true);
    expect(completeMock).toHaveBeenCalledTimes(1);

    const sidecar = sessionPath.replace('.json', '') + '.factlog.json';
    expect(fs.existsSync(sidecar)).toBe(true);
    const log = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    expect(log.bullets).toEqual(['- did a thing', '- set a value']);
    expect(log.compactionCount).toBe(1);
    expect(metrics?.newBullets).toBe(2);

    // The in-history placeholder reflects the same bullets.
    const placeholder = h[1] as { content: string };
    expect(placeholder.content).toContain('- did a thing');
    expect(placeholder.content).toContain('- set a value');
  });

  it('second compaction pass appends to the sidecar incrementally — never rewrites prior bullets, never re-summarizes old turns', async () => {
    const h = bigHistory();
    await compactHistoryTiered(h, estimate(h), 'test-model', sessionPath);
    const sidecar = sessionPath.replace('.json', '') + '.factlog.json';
    const firstLog = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    expect(firstLog.bullets).toEqual(['- did a thing', '- set a value']);

    completeMock.mockClear();
    completeMock.mockResolvedValueOnce({
      text: '- second pass fact',
      toolCalls: [],
      stopReason: 'done' as const,
    });

    // Grow past the gen-1 (70%) threshold with fresh turns.
    for (let i = 0; i < 4; i++) {
      h.push(user(`follow-up ${i} ` + text(700)));
      h.push(assistant(`working on follow-up ${i}`, [{ id: `d${i}`, name: 'edit_file', input: { path: `g${i}.ts` } }]));
      h.push(toolResult('edit_file', text(700)));
    }
    const { compacted, metrics } = await compactHistoryTiered(h, estimate(h), 'test-model', sessionPath);
    expect(compacted).toBe(true);
    expect(metrics?.compactionCount).toBe(2);

    // Only the newly aged-out turns were sent to the summary model — none of
    // the already-summarized instruction/write_file turns from the first
    // pass appear in the second call's transcript.
    const secondCallTranscript = completeMock.mock.calls[0][1][0].content as string;
    expect(secondCallTranscript).not.toContain('instruction 0');
    expect(secondCallTranscript).toContain('follow-up 0');

    const secondLog = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    // Prior bullets preserved verbatim as a prefix, new bullet appended.
    expect(secondLog.bullets.slice(0, firstLog.bullets.length)).toEqual(firstLog.bullets);
    expect(secondLog.bullets).toEqual(['- did a thing', '- set a value', '- second pass fact']);
  });

  it('falls back to in-memory fact log (no sidecar file) for ephemeral sessions with no sessionPath', async () => {
    const h = bigHistory();
    const { compacted } = await compactHistoryTiered(h, estimate(h), 'test-model', undefined);
    expect(compacted).toBe(true);
    const placeholder = h[1] as { content: string };
    expect(placeholder.content).toContain('did a thing');
  });
});

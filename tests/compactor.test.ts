import { describe, it, expect, vi } from 'vitest';
import type { HistoryMessage } from '../src/providers/types.js';

// Pin the context window so budget math is deterministic regardless of the
// provider registry contents.
const WINDOW = 10_000; // threshold = 7,500 tokens; retain budget = 4,000
vi.mock('../src/providers/factory.js', () => ({
  getContextWindow: (model: string) => (model === 'test-model' ? WINDOW : undefined),
}));

const { compactHistory, estimateContextTokens } = await import('../src/agent/compactor.js');

const user = (content: string): HistoryMessage => ({ role: 'user', content });
const assistant = (content: string, toolCalls?: HistoryMessage extends never ? never : any[]): HistoryMessage =>
  ({ role: 'assistant', content, toolCalls });
const toolResult = (name: string, content: string): HistoryMessage =>
  ({ role: 'tool_result', results: [{ id: 't1', name, content, isError: false }] });

/** ~tokens → string (compactor falls back to 3.5 chars/token). */
const text = (tokens: number) => 'x'.repeat(Math.ceil(tokens * 3.5));

function bigHistory(): HistoryMessage[] {
  // 1 task + 5 turns of (user ~900 + assistant + tool_result ~900) ≈ 9,100
  // tokens under the 3.5-chars/token fallback — above the 7,500 threshold.
  const h: HistoryMessage[] = [user('original task: refactor the parser')];
  for (let i = 0; i < 5; i++) {
    h.push(user(`instruction ${i} ` + text(900)));
    h.push(assistant(`working on ${i}`, [{ id: `c${i}`, name: 'write_file', input: { path: `f${i}.ts` } }]));
    h.push(toolResult('write_file', text(900)));
  }
  return h;
}

describe('compactHistory', () => {
  it('no-ops below the threshold', () => {
    const h = [user('task'), assistant('done')];
    const est = estimateContextTokens('', h);
    expect(compactHistory(h, est, 'test-model')).toBe(false);
    expect(h.length).toBe(2);
  });

  it('compacts above threshold, keeping task + recap + tail within the retention budget', () => {
    const h = bigHistory();
    const before = h.length;
    const est = estimateContextTokens('', h);
    expect(est).toBeGreaterThan(WINDOW * 0.75);

    expect(compactHistory(h, est, 'test-model')).toBe(true);
    expect(h.length).toBeLessThan(before);
    expect(h[0].content).toContain('original task');
    expect(h[1].role).toBe('assistant');
    expect((h[1] as { content: string }).content).toContain('compacted');

    // Tail (everything after the recap) fits the 40% retention budget,
    // allowing the snap-to-user-turn overshoot of up to 6 messages.
    const tail = h.slice(2);
    const tailTokens = estimateContextTokens('', tail);
    expect(tailTokens).toBeLessThanOrEqual(WINDOW * 0.40 + 6 * 1300);
  });

  it('never lets the kept slice start with an orphaned tool_result', () => {
    const h = bigHistory();
    compactHistory(h, estimateContextTokens('', h), 'test-model');
    expect(h[2].role).not.toBe('tool_result');
    // Every kept tool_result must be preceded (after the recap) by an
    // assistant message carrying toolCalls.
    for (let i = 2; i < h.length; i++) {
      if (h[i].role === 'tool_result') {
        const prev = h[i - 1];
        expect(prev.role).toBe('assistant');
        expect((prev as { toolCalls?: unknown[] }).toolCalls?.length).toBeTruthy();
      }
    }
  });

  it('injects executive digest and affect hint into the recap', () => {
    const h = bigHistory();
    compactHistory(h, estimateContextTokens('', h), 'test-model', {
      executiveDigest: 'Recent state-altering actions already executed (do not repeat):\nwrite_file f1.ts',
      affectHint: 'Note: recent user messages show signs of frustration — prioritize directness, verify before claiming success.',
    });
    const recap = (h[1] as { content: string }).content;
    expect(recap).toContain('do not repeat');
    expect(recap).toContain('write_file f1.ts');
    expect(recap).toContain('frustration');
  });

  it('falls back to DEFAULT_WINDOW for unknown models (no compaction at small sizes)', () => {
    const h = bigHistory(); // ~9.7k tokens, far below 128k * 0.75
    expect(compactHistory(h, estimateContextTokens('', h), 'mystery-model')).toBe(false);
  });

  it('churn guard truncates oversized tool_result bodies when still over threshold', () => {
    // One colossal tool_result in the tail that alone exceeds the threshold.
    const h: HistoryMessage[] = [
      user('task'),
      user('another instruction'),
      assistant('running', [{ id: 'c1', name: 'run_shell', input: { command: 'cat big.log' } }]),
      toolResult('run_shell', text(9_000)), // ~9k tokens > 7.5k threshold on its own
    ];
    const est = estimateContextTokens('', h);
    expect(compactHistory(h, est, 'test-model')).toBe(true);
    const kept = h.find(m => m.role === 'tool_result') as { results: { content: string }[] } | undefined;
    expect(kept).toBeDefined();
    expect(kept!.results[0].content.length).toBeLessThanOrEqual(4_000 + '\n[truncated during compaction]'.length);
    expect(kept!.results[0].content).toContain('[truncated during compaction]');
  });
});

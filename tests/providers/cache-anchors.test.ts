import { describe, it, expect } from 'vitest';
import { toAnthropicMessages } from '../../src/providers/anthropic.js';
import { selectTools, TOOL_DEFINITIONS } from '../../src/tools/index.js';
import type { HistoryMessage } from '../../src/providers/types.js';

const user = (content: string): HistoryMessage => ({ role: 'user', content });
const assistant = (content: string, toolCalls?: any[]): HistoryMessage =>
  ({ role: 'assistant', content, toolCalls });
const toolResult = (name: string, content: string): HistoryMessage =>
  ({ role: 'tool_result', results: [{ id: 't1', name, content, isError: false }] });

/** Indices of messages carrying a cache_control breakpoint. */
function breakpointIndices(msgs: ReturnType<typeof toAnthropicMessages>): number[] {
  const out: number[] = [];
  msgs.forEach((m, i) => {
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (blocks.some(b => (b as any).cache_control)) out.push(i);
  });
  return out;
}

/** One turn = user + assistant(tool call) + tool_result, i.e. 3 messages —
 *  deliberately not a multiple of 4, which is what broke the old scheme. */
function turns(n: number, from = 0): HistoryMessage[] {
  const h: HistoryMessage[] = [];
  for (let i = from; i < from + n; i++) {
    h.push(user(`instruction ${i}`));
    h.push(assistant(`working ${i}`, [{ id: `c${i}`, name: 'read_file', input: { path: `f${i}.ts` } }]));
    h.push(toolResult('read_file', `contents ${i}`));
  }
  return h;
}

describe('anthropic cache anchors', () => {
  it('always anchors the original task at index 0', () => {
    const msgs = toAnthropicMessages([user('original task'), ...turns(4)]);
    expect(breakpointIndices(msgs)).toContain(0);
  });

  it('keeps the anchor on index 0 as history grows — the old scheme drifted', () => {
    // The previous implementation marked every 4th message counting back from
    // the tail, so each appended turn moved every breakpoint onto a different
    // absolute message and wrote a fresh cache entry nobody would reuse.
    const seen = new Set<string>();
    for (let n = 1; n <= 8; n++) {
      const msgs = toAnthropicMessages([user('original task'), ...turns(n)]);
      const idx = breakpointIndices(msgs);
      expect(idx).toContain(0);
      seen.add(JSON.stringify(idx));
    }
    // With no recap present the only anchor is index 0 — identical every time.
    expect([...seen]).toEqual(['[0]']);
  });

  it('anchors the compaction recap as a second breakpoint', () => {
    const h = [
      user('original task'),
      assistant('[Earlier conversation compacted (gen 1): 12 turns removed to stay within context limits.]'),
      ...turns(3),
    ];
    const idx = breakpointIndices(toAnthropicMessages(h));
    expect(idx).toEqual([0, 1]);
  });

  it('anchors the tiered fact-log block too', () => {
    const h = [
      user('original task'),
      assistant('[Context fact log: 9 facts from earlier turns.]'),
      ...turns(2),
    ];
    expect(breakpointIndices(toAnthropicMessages(h))).toEqual([0, 1]);
  });

  it('holds the recap anchor steady while later turns accumulate', () => {
    const head = [
      user('original task'),
      assistant('[Context fact log: 9 facts from earlier turns.]'),
    ];
    const a = breakpointIndices(toAnthropicMessages([...head, ...turns(2)]));
    const b = breakpointIndices(toAnthropicMessages([...head, ...turns(5)]));
    const c = breakpointIndices(toAnthropicMessages([...head, ...turns(9)]));
    expect(a).toEqual([0, 1]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('never exceeds Anthropic\'s budget (4 total: system + tools + 2 here)', () => {
    const h = [
      user('task'),
      assistant('[Earlier conversation compacted (gen 2): 30 turns removed to stay within context limits.]'),
      ...turns(20),
    ];
    expect(breakpointIndices(toAnthropicMessages(h)).length).toBeLessThanOrEqual(2);
  });

  it('picks the most recent recap when several survive in history', () => {
    const h = [
      user('task'),                                                        // 0
      assistant('[Earlier conversation compacted (gen 1): 5 turns removed.]'), // 1
      ...turns(1),                                                         // 2,3,4
      assistant('[Earlier conversation compacted (gen 2): 9 turns removed.]'), // 5
      ...turns(1),                                                         // 6,7,8
    ];
    const idx = breakpointIndices(toAnthropicMessages(h));
    expect(idx).toEqual([0, 5]);
  });

  it('handles an empty history without emitting breakpoints', () => {
    expect(breakpointIndices(toAnthropicMessages([]))).toEqual([]);
  });
});

describe('tool block byte-stability', () => {
  // The tools block sits inside the cacheable prefix (toCachedTools marks its
  // last entry), so any nondeterminism here costs a cache miss every call.
  it('is byte-identical across repeated calls with the same inputs', () => {
    const a = JSON.stringify(selectTools('refactor the parser', []));
    const b = JSON.stringify(selectTools('refactor the parser', []));
    expect(a).toBe(b);
  });

  it('inserts newly-triggered conditional tools at canonical position, not appended', () => {
    // Order comes from filtering a fixed TOOL_DEFINITIONS array, so a tool
    // admitted mid-session does not reorder the ones already present.
    const canonical = TOOL_DEFINITIONS.map(t => t.name);
    const selected = selectTools('fetch a website and browse it', []).map(t => t.name);
    let i = 0;
    for (const name of canonical) if (name === selected[i]) i++;
    expect(i).toBe(selected.length);
  });

  it('keeps already-present tools in the same relative order as tools are added', () => {
    const base = selectTools('plain task', []).map(t => t.name);
    const wider = selectTools('fetch a website and browse it', []).map(t => t.name);
    expect(wider.filter(n => base.includes(n))).toEqual(base);
  });
});

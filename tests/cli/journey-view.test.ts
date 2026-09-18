import { describe, it, expect } from 'vitest';
import type { LearningGraph, JourneyItem } from '../../src/agent/learning-graph.js';
import {
  initialState, renderJourney, journeyKey, splitKeys, WINDOWS, type JourneyState,
} from '../../src/cli/journey-view.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function graph(n: number): LearningGraph {
  const items: JourneyItem[] = Array.from({ length: n }, (_, i) => ({
    id: `r${i}`, at: new Date(2026, 8, 19, 12, 0, n - i).toISOString(), kind: i % 5 === 0 ? 'lesson' : 'run',
    title: `item ${i}`, text: `the full text of item ${i} `.repeat(20), ok: i % 2 === 0, source: 'm',
  }));
  const runs = items.filter(i => i.kind === 'run');
  return {
    since: '2026-09-13', until: '2026-09-19',
    days: Array.from({ length: 7 }, (_, d) => ({
      date: `2026-09-${13 + d}`, runs: d === 6 ? runs.length : 0,
      succeeded: d === 6 ? runs.filter(r => r.ok).length : 0, failed: d === 6 ? runs.filter(r => !r.ok).length : 0,
      lessons: d === 6 ? n - runs.length : 0, memories: 0,
    })),
    items,
    totals: { runs: runs.length, succeeded: runs.filter(r => r.ok).length, failed: runs.filter(r => !r.ok).length, lessons: n - runs.length, memories: 0 },
    eras: [],
  };
}

const st = (n = 40): JourneyState => initialState(graph(n), 30);
const press = (s: JourneyState, ...keys: string[]) => keys.reduce<JourneyState>((acc, k) => {
  const r = journeyKey(acc, k, 24);
  if (r === 'exit' || 'reload' in r) throw new Error(`unexpected ${JSON.stringify(r)}`);
  return r;
}, s);

describe('renderJourney', () => {
  it('fills exactly the screen and never overflows a line', () => {
    for (const [c, r] of [[40, 12], [80, 24], [160, 50]]) {
      for (const s of [st(), press(st(), '\r')]) {
        const lines = renderJourney(s, c, r);
        expect(lines).toHaveLength(r);
        for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(c);
      }
    }
  });

  it('shows the key help and position on the last line', () => {
    const last = strip(renderJourney(press(st(), '\x1b[B', '\x1b[B'), 80, 24).at(-1)!);
    expect(last).toContain('Enter open');
    expect(last).toContain('3/40');
  });

  it('opens the selected item in full', () => {
    const lines = renderJourney(press(st(), 'j', 'j', '\r'), 80, 24).map(strip).join('\n');
    expect(lines).toContain('the full text of item 2');
    expect(lines).toContain('Esc back');
  });
});

describe('journeyKey', () => {
  it('moves and clamps the selection', () => {
    expect(press(st(), 'k').selected).toBe(0);
    expect(press(st(), 'j', 'j', '\x1b[B').selected).toBe(3);
    expect(press(st(), 'G').selected).toBe(39);
    expect(press(st(), 'G', 'j').selected).toBe(39);
    expect(press(st(), 'G', 'g').selected).toBe(0);
    expect(press(st(), '\x1b[6~').selected).toBeGreaterThan(1);
  });

  it('Esc leaves the detail view first, then closes', () => {
    const d = press(st(), '\r');
    expect(d.mode).toBe('detail');
    const back = journeyKey(d, '\x1b', 24);
    expect(back).not.toBe('exit');
    expect((back as JourneyState).mode).toBe('list');
    expect(journeyKey(back as JourneyState, '\x1b', 24)).toBe('exit');
    expect(journeyKey(st(), 'q', 24)).toBe('exit');
    expect(journeyKey(d, '\x03', 24)).toBe('exit');
  });

  it('asks for a rebuild on reload and cycles the window', () => {
    expect(journeyKey(st(), 'r', 24)).toEqual({ reload: 30 });
    expect(journeyKey(st(), 'w', 24)).toEqual({ reload: WINDOWS[WINDOWS.indexOf(30) + 1] });
    expect(journeyKey(initialState(graph(1), 365), 'w', 24)).toEqual({ reload: 7 });
  });

  it('does not open anything when the list is empty', () => {
    expect(press(st(0), '\r').mode).toBe('list');
  });
});

describe('splitKeys', () => {
  it('splits sequences and plain keys', () => {
    expect(splitKeys('jj\x1b[B\x1b[6~q')).toEqual(['j', 'j', '\x1b[B', '\x1b[6~', 'q']);
    expect(splitKeys('\x1b')).toEqual(['\x1b']);
    expect(splitKeys('\r')).toEqual(['\r']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LADDER, MIN_RUNG, MAX_RUNG, MIN_GAP,
  getLadder, setLadder, resetLadder, normalizeLadder, thresholdRatioFor,
  DEFAULT_MAX_CONTEXT_TOKENS, MIN_MAX_CONTEXT_TOKENS, getMaxContextTokens, setMaxContextTokens,
  compactionThreshold, retentionBudget,
} from '../src/agent/context-policy.js';
import {
  initTunerState, nudge, cycle, commit, renderTuner, runTuner, splitKeys,
  FINE_STEP, COARSE_STEP, type TunerIO,
} from '../src/cli/context-tuner.js';

/** Collects everything the tuner writes and lets a test feed it raw chunks. */
function fakeIO(columns = 100) {
  let handler: ((k: string) => void) | null = null;
  const writes: string[] = [];
  const io: TunerIO = {
    write: (s) => { writes.push(s); },
    columns: () => columns,
    onKey: (h) => { handler = h; return () => { handler = null; }; },
  };
  return {
    io,
    writes,
    send: (chunk: string) => handler?.(chunk),
    get disposed() { return handler === null; },
  };
}

beforeEach(() => resetLadder());

describe('context policy', () => {
  it('defaults to the built-in ladder', () => {
    expect(getLadder()).toEqual(DEFAULT_LADDER);
  });

  it('holds the last rung once the ladder is exhausted', () => {
    expect(thresholdRatioFor(0)).toBe(0.55);
    expect(thresholdRatioFor(2)).toBe(0.85);
    expect(thresholdRatioFor(99)).toBe(0.85);
  });

  it('treats a negative generation as the first rung', () => {
    expect(thresholdRatioFor(-1)).toBe(0.55);
  });

  it('sorts an out-of-order ladder ascending', () => {
    expect(normalizeLadder([0.8, 0.3, 0.6])).toEqual([0.3, 0.6, 0.8]);
  });

  it('clamps rungs into the legal range', () => {
    const l = normalizeLadder([-5, 0.5, 42]);
    expect(l[0]).toBeGreaterThanOrEqual(MIN_RUNG);
    expect(l[l.length - 1]).toBeLessThanOrEqual(MAX_RUNG);
  });

  it('pushes apart rungs that collapse onto each other', () => {
    const l = normalizeLadder([0.5, 0.5, 0.5]);
    expect(l[1] - l[0]).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
    expect(l[2] - l[1]).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
  });

  it('keeps separation even when pushing apart would exceed the ceiling', () => {
    const l = normalizeLadder([0.95, 0.95, 0.95]);
    expect(l[l.length - 1]).toBeLessThanOrEqual(MAX_RUNG);
    for (let i = 1; i < l.length; i++) {
      expect(l[i]).toBeGreaterThan(l[i - 1]);
    }
  });

  it('stays ascending even when more rungs are given than the range can hold', () => {
    const l = normalizeLadder(new Array(200).fill(0.5));
    expect(l).toHaveLength(200);
    expect(l[0]).toBeGreaterThanOrEqual(MIN_RUNG - 1e-9);
    expect(l[l.length - 1]).toBeLessThanOrEqual(MAX_RUNG + 1e-9);
    for (let i = 1; i < l.length; i++) {
      expect(l[i]).toBeGreaterThanOrEqual(l[i - 1]);
    }
  });

  it('falls back to defaults when nothing usable survives', () => {
    expect(normalizeLadder([])).toEqual([...DEFAULT_LADDER]);
    expect(normalizeLadder([NaN, Infinity])).toEqual([...DEFAULT_LADDER]);
  });

  it('normalizes on install so a bad config cannot disable compaction', () => {
    setLadder([0.9, 0.1]);
    expect(getLadder()).toEqual([0.1, 0.9]);
  });
});

describe('tuner state', () => {
  it('starts on the first rung with a copy of the live ladder', () => {
    const s = initTunerState();
    expect(s.selected).toBe(0);
    expect(s.ladder).toEqual([...DEFAULT_LADDER]);
    // Mutating the working copy must not touch the live policy.
    s.ladder[0] = 0.11;
    expect(getLadder()[0]).toBe(0.55);
  });

  it('moves the selected rung', () => {
    const s = nudge(initTunerState(), FINE_STEP);
    expect(s.ladder[0]).toBeCloseTo(0.56, 5);
    expect(s.ladder[1]).toBe(0.70);
  });

  it('will not let a rung cross the one above it', () => {
    let s = initTunerState();          // [0.55, 0.70, 0.85], on rung 0
    for (let i = 0; i < 100; i++) s = nudge(s, FINE_STEP);
    expect(s.ladder[0]).toBeLessThanOrEqual(s.ladder[1] - MIN_GAP + 1e-9);
    expect(s.ladder[0]).toBeLessThan(s.ladder[1]);
  });

  it('will not let a rung cross the one below it', () => {
    let s = cycle(initTunerState(), 1); // select rung 1
    for (let i = 0; i < 100; i++) s = nudge(s, -FINE_STEP);
    expect(s.ladder[1]).toBeGreaterThanOrEqual(s.ladder[0] + MIN_GAP - 1e-9);
    expect(s.ladder[1]).toBeGreaterThan(s.ladder[0]);
  });

  it('clamps the first rung at the floor and the last at the ceiling', () => {
    let first = initTunerState();
    for (let i = 0; i < 200; i++) first = nudge(first, -FINE_STEP);
    expect(first.ladder[0]).toBeCloseTo(MIN_RUNG, 5);

    let last = initTunerState();
    last = { ...last, selected: last.ladder.length - 1 };
    for (let i = 0; i < 200; i++) last = nudge(last, FINE_STEP);
    expect(last.ladder[last.ladder.length - 1]).toBeCloseTo(MAX_RUNG, 5);
  });

  it('keeps the ladder ascending through arbitrary nudging', () => {
    let s = initTunerState();
    for (const [sel, dir] of [[0, 1], [2, -1], [1, 1], [1, -1], [0, -1]] as const) {
      s = { ...s, selected: sel };
      for (let i = 0; i < 30; i++) s = nudge(s, dir * FINE_STEP);
    }
    for (let i = 1; i < s.ladder.length; i++) {
      expect(s.ladder[i]).toBeGreaterThan(s.ladder[i - 1]);
    }
  });

  it('cycles selection with wraparound in both directions', () => {
    const s = initTunerState();
    expect(cycle(s, 1).selected).toBe(1);
    expect(cycle(cycle(cycle(s, 1), 1), 1).selected).toBe(0);
    expect(cycle(s, -1).selected).toBe(2);
  });

  it('commits the working ladder to the live policy', () => {
    let s = initTunerState();
    for (let i = 0; i < 10; i++) s = nudge(s, -FINE_STEP);
    const saved = commit(s);
    expect(saved[0]).toBeCloseTo(0.45, 5);
    expect(getLadder()[0]).toBeCloseTo(0.45, 5);
  });
});

describe('tuner rendering', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('shows the selected rung percentage and its token value', () => {
    const out = strip(renderTuner(initTunerState(), 128_000, 6_200));
    expect(out).toContain('rung 1/3: 55%');
    expect(out).toContain('70.4k');       // 0.55 * 128k
  });

  it('reports usage against the window', () => {
    const out = strip(renderTuner(initTunerState(), 1_000_000, 6_200));
    expect(out).toContain('6.2k/1000k');
    expect(out).toContain('1%');
  });

  it('renders one caret and follows the selection', () => {
    const first = strip(renderTuner(initTunerState(), 128_000, 0));
    const third = strip(renderTuner({ ...initTunerState(), selected: 2 }, 128_000, 0));
    expect(first.match(/▲/g)).toHaveLength(1);
    expect(first.indexOf('▲')).toBeLessThan(third.indexOf('▲'));
    expect(third).toContain('rung 3/3: 85%');
  });

  it('survives a zero-width window without dividing by zero', () => {
    const out = strip(renderTuner(initTunerState(), 0, 0));
    expect(out).toContain('rung 1/3');
    expect(out).not.toContain('NaN');
  });

  it('shows every rung in the summary line', () => {
    const out = strip(renderTuner(initTunerState(), 128_000, 0));
    expect(out).toContain('55% → 70% → 85%');
  });
});

describe('key splitting', () => {
  it('splits a coalesced burst of held arrow presses', () => {
    expect(splitKeys('\x1b[D\x1b[D\x1b[D')).toEqual(['\x1b[D', '\x1b[D', '\x1b[D']);
  });

  it('keeps modified sequences intact', () => {
    expect(splitKeys('\x1b[1;2C')).toEqual(['\x1b[1;2C']);
    expect(splitKeys('\x1b[Z')).toEqual(['\x1b[Z']);
  });

  it('normalizes SS3 arrows to the CSI form', () => {
    expect(splitKeys('\x1bOD')).toEqual(['\x1b[D']);
    expect(splitKeys('\x1bOC\x1bOC')).toEqual(['\x1b[C', '\x1b[C']);
  });

  it('handles a bare escape and plain characters', () => {
    expect(splitKeys('\x1b')).toEqual(['\x1b']);
    expect(splitKeys('\t\r')).toEqual(['\t', '\r']);
  });

  it('splits a mixed chunk', () => {
    expect(splitKeys('\x1b[D\t\x1b[C\r')).toEqual(['\x1b[D', '\t', '\x1b[C', '\r']);
  });
});

describe('runTuner redraw', () => {
  const CSI_UP = /\x1b\[(\d+)A/;

  it('rewinds over the previous frame instead of appending a new one', async () => {
    const f = fakeIO();
    const done = runTuner(f.io, 1_000_000, 4_800);

    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).not.toMatch(CSI_UP);  // first frame has nothing to erase
    const rows = f.writes[0].replace(/\n$/, '').split('\n').length;

    f.send('\x1b[D');
    expect(f.writes).toHaveLength(2);
    const m = f.writes[1].match(CSI_UP);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(rows);        // moves up exactly one frame height
    expect(f.writes[1]).toContain('\x1b[0J'); // and clears downward

    f.send('\x1b');
    await done;
  });

  it('emits one frame per burst, not one per key', async () => {
    const f = fakeIO();
    const done = runTuner(f.io, 1_000_000, 4_800);
    f.send('\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D');
    expect(f.writes).toHaveLength(2);        // initial + one redraw
    f.send('\x1b');
    await done;
  });

  it('applies every key in a coalesced burst', async () => {
    const f = fakeIO();
    const done = runTuner(f.io, 1_000_000, 4_800);
    f.send('\x1b[D'.repeat(5));              // 5 × 1pp down from 55%
    f.send('\r');
    const saved = await done;
    expect(saved![0]).toBeCloseTo(0.50, 5);
  });

  it('ignores unmapped keys without redrawing', async () => {
    const f = fakeIO();
    const done = runTuner(f.io, 1_000_000, 4_800);
    f.send('xyz');
    expect(f.writes).toHaveLength(1);
    f.send('\x1b');
    await done;
  });

  it('resolves null on Esc and leaves the live ladder untouched', async () => {
    const f = fakeIO();
    const done = runTuner(f.io, 1_000_000, 4_800);
    f.send('\x1b[D\x1b[D');
    f.send('\x1b');
    expect(await done).toBeNull();
    expect(getLadder()).toEqual(DEFAULT_LADDER);
    expect(f.disposed).toBe(true);
  });

  it('commits on Enter and stops listening', async () => {
    const f = fakeIO();
    const done = runTuner(f.io, 1_000_000, 4_800);
    f.send('\x1b[1;2C');                     // Shift+→ : one coarse step up
    f.send('\r');
    const saved = await done;
    expect(saved![0]).toBeCloseTo(0.55 + COARSE_STEP, 5);
    expect(getLadder()[0]).toBeCloseTo(0.55 + COARSE_STEP, 5);
    expect(f.disposed).toBe(true);
  });

  it('keeps every frame within the terminal width so nothing wraps', async () => {
    const f = fakeIO(46);
    const done = runTuner(f.io, 1_000_000, 4_800);
    for (const line of f.writes[0].replace(/\n$/, '').split('\n')) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(46);
    }
    f.send('\x1b');
    await done;
  });
});

describe('absolute compaction ceiling', () => {
  it('does not change behaviour for a 128k window (rung 1 already below the cap)', () => {
    // 0.55 * 128k = 70.4k < 80k default cap -> ladder still governs.
    expect(compactionThreshold(128_000, 0)).toBe(Math.floor(128_000 * 0.55));
    expect(retentionBudget(128_000)).toBe(Math.floor(128_000 * 0.40));
  });

  it('binds on a 1M window, where the ladder alone never would', () => {
    expect(Math.floor(1_000_000 * 0.55)).toBe(550_000);   // what it used to be
    expect(compactionThreshold(1_000_000, 0)).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('caps every generation, not just the first', () => {
    for (const gen of [0, 1, 2, 9]) {
      expect(compactionThreshold(1_000_000, gen)).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    }
  });

  it('keeps retention below the trigger so compaction cannot instantly re-fire', () => {
    const trigger = compactionThreshold(1_000_000, 0);
    const retain = retentionBudget(1_000_000);
    expect(retain).toBeLessThan(trigger);
    expect(trigger - retain).toBeGreaterThan(trigger * 0.2);  // real headroom
  });

  it('honours a configured cap', () => {
    setMaxContextTokens(40_000);
    expect(compactionThreshold(1_000_000, 0)).toBe(40_000);
    expect(compactionThreshold(128_000, 0)).toBe(40_000);    // now binds here too
  });

  it('refuses a cap small enough to compact away the working set', () => {
    setMaxContextTokens(500);
    expect(getMaxContextTokens()).toBe(MIN_MAX_CONTEXT_TOKENS);
  });

  it('treats 0 as "disable the cap" and falls back to the ladder', () => {
    setMaxContextTokens(0);
    expect(compactionThreshold(1_000_000, 0)).toBe(550_000);
  });

  it('resets with the rest of the policy', () => {
    setMaxContextTokens(12_345);
    resetLadder();
    expect(getMaxContextTokens()).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });
});

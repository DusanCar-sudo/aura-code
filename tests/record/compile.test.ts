import { describe, it, expect } from 'vitest';
import { charFor, compile, describe as describeStep, typedRuns } from '../../src/record/compile.js';
import type { RawEvent } from '../../src/record/types.js';

/**
 * Thirty seconds of demonstration is a few thousand press/release pairs.
 * Nobody reviews that and no agent acts on it, so the compiler's whole job is
 * turning it into the handful of steps the demonstrator would have said out
 * loud. These pin the cases that are miserable to reproduce by hand — a chord
 * overlapping the next keystroke, a shift held across two letters — which is
 * exactly why the compiler is pure.
 */

let clock = 0;
const key = (code: string, value: number, t?: number): RawEvent =>
  ({ t: t ?? (clock += 10), kind: 'key', code, value });
const btn = (code: string, value: number, t?: number): RawEvent =>
  ({ t: t ?? (clock += 10), kind: 'button', code, value });
const tap = (code: string) => [key(code, 1), key(code, 0)];

const reset = () => { clock = 0; };

describe('characters', () => {
  it('maps letters, digits and punctuation, shifted and not', () => {
    expect(charFor('KEY_A', false)).toBe('a');
    expect(charFor('KEY_A', true)).toBe('A');
    expect(charFor('KEY_4', false)).toBe('4');
    expect(charFor('KEY_4', true)).toBe('$');
    expect(charFor('KEY_SLASH', true)).toBe('?');
    expect(charFor('KEY_ENTER', false)).toBeNull();
  });
});

describe('typing', () => {
  it('coalesces a run of keys into one step', () => {
    reset();
    const steps = compile([...tap('KEY_H'), ...tap('KEY_I')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'type', text: 'hi' });
  });

  it('treats shift as capitalisation, not as a chord', () => {
    // Shift+A is a capital A. Emitting "Shift+A" as a keyboard shortcut would
    // make every sentence with a capital letter read as a hotkey.
    reset();
    const steps = compile([
      key('KEY_LEFTSHIFT', 1), ...tap('KEY_H'), key('KEY_LEFTSHIFT', 0), ...tap('KEY_I'),
    ]);
    expect(steps).toEqual([expect.objectContaining({ kind: 'type', text: 'Hi' })]);
  });

  it('ignores releases and auto-repeat', () => {
    // Holding a key for 400ms is one intention, however many events it made.
    reset();
    const steps = compile([key('KEY_A', 1), key('KEY_A', 2), key('KEY_A', 2), key('KEY_A', 0)]);
    expect(steps).toEqual([expect.objectContaining({ text: 'a' })]);
  });
});

describe('chords', () => {
  it('reads Ctrl+C as one step, not three', () => {
    reset();
    const steps = compile([
      key('KEY_LEFTCTRL', 1), ...tap('KEY_C'), key('KEY_LEFTCTRL', 0),
    ]);
    expect(steps).toEqual([expect.objectContaining({ kind: 'press', label: 'Ctrl+C' })]);
  });

  it('orders modifiers predictably', () => {
    reset();
    const steps = compile([
      key('KEY_LEFTSHIFT', 1), key('KEY_LEFTCTRL', 1), ...tap('KEY_S'),
    ]);
    expect(steps[0]).toMatchObject({ label: 'Ctrl+Shift+S' });
  });

  it('breaks a typing run when a chord interrupts it', () => {
    // "ab", Ctrl+C, "cd" is three steps. Folding the chord into the text would
    // replay it as literal characters.
    reset();
    const steps = compile([
      ...tap('KEY_A'), ...tap('KEY_B'),
      key('KEY_LEFTCTRL', 1), ...tap('KEY_C'), key('KEY_LEFTCTRL', 0),
      ...tap('KEY_D'),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['type', 'press', 'type']);
    expect(steps[0]).toMatchObject({ text: 'ab' });
    expect(steps[2]).toMatchObject({ text: 'd' });
  });

  it('names action keys rather than typing them', () => {
    reset();
    const steps = compile([...tap('KEY_ENTER'), ...tap('KEY_DOWN')]);
    expect(steps.map((s) => (s as { label: string }).label)).toEqual(['Enter', 'Down']);
  });
});

describe('the mouse', () => {
  it('records a click with the screenshot that shows where', () => {
    // Wayland will not say where the pointer is, so the shot is the only thing
    // that carries the location — see record/types.ts.
    reset();
    const steps = compile([...[btn('BTN_LEFT', 1), btn('BTN_LEFT', 0)]], { shots: ['s1.png'] });
    expect(steps[0]).toMatchObject({ kind: 'click', button: 'left', count: 1, shot: 's1.png' });
  });

  it('folds a quick second click into a double-click', () => {
    // Replaying two clicks where the user double-clicked opens a thing twice.
    reset();
    const steps = compile([
      btn('BTN_LEFT', 1, 100), btn('BTN_LEFT', 0, 110),
      btn('BTN_LEFT', 1, 250), btn('BTN_LEFT', 0, 260),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'click', count: 2 });
  });

  it('keeps two deliberate clicks apart', () => {
    reset();
    const steps = compile([
      btn('BTN_LEFT', 1, 100), btn('BTN_LEFT', 0, 110),
      btn('BTN_LEFT', 1, 3000), btn('BTN_LEFT', 0, 3010),
    ]);
    expect(steps.filter((s) => s.kind === 'click')).toHaveLength(2);
  });

  it('sums a scroll stream into one movement', () => {
    reset();
    const steps = compile([
      { t: 10, kind: 'scroll', code: 'REL_WHEEL', value: -1 },
      { t: 20, kind: 'scroll', code: 'REL_WHEEL', value: -1 },
      { t: 30, kind: 'scroll', code: 'REL_WHEEL', value: -1 },
    ]);
    expect(steps).toEqual([expect.objectContaining({ kind: 'scroll', direction: 'down', notches: 3 })]);
  });
});

describe('pauses', () => {
  it('records a long gap as a wait — the demonstrator was waiting for something', () => {
    const steps = compile([
      key('KEY_A', 1, 0), key('KEY_A', 0, 10),
      key('KEY_B', 1, 5000), key('KEY_B', 0, 5010),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['type', 'wait', 'type']);
    expect(steps[1]).toMatchObject({ kind: 'wait', ms: 5000 });
  });

  it('ignores the ordinary rhythm of typing', () => {
    reset();
    const steps = compile([...tap('KEY_A'), ...tap('KEY_B')]);
    expect(steps.some((s) => s.kind === 'wait')).toBe(false);
  });
});

describe('review and display', () => {
  it('collects everything typed, for the operator to read before it is kept', () => {
    reset();
    const steps = compile([...tap('KEY_H'), ...tap('KEY_I'), ...tap('KEY_ENTER')]);
    expect(typedRuns(steps)).toEqual(['hi']);
  });

  it('describes each step in one line', () => {
    reset();
    const steps = compile([
      key('KEY_LEFTCTRL', 1), ...tap('KEY_C'), key('KEY_LEFTCTRL', 0),
    ]);
    expect(describeStep(steps[0])).toBe('press Ctrl+C');
  });

  it('is empty for an empty recording', () => {
    expect(compile([])).toEqual([]);
    expect(typedRuns([])).toEqual([]);
  });
});

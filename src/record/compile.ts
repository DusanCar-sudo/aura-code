/**
 * Turning what the kernel saw into something a person can read.
 *
 * A raw recording of thirty seconds of work is a few thousand press/release
 * pairs. Nobody can review that, and no agent can act on it. This compiles it
 * into the handful of steps the demonstrator would have described out loud:
 * "click here, Ctrl+C, alt-tab, Ctrl+V, down arrow".
 *
 * The compiler is pure and takes the whole event list, so it can be tested
 * without a keyboard, a display, or a recording session — which matters,
 * because the interesting cases here (a chord that overlaps the next
 * keystroke, a shift held across two letters) are exactly the ones that are
 * miserable to reproduce by hand.
 */

import type { RawEvent, Step } from './types.js';

/** Held-modifier names, keyed by the evdev code that sets them. */
const MODIFIERS: Record<string, string> = {
  KEY_LEFTCTRL: 'Ctrl', KEY_RIGHTCTRL: 'Ctrl',
  KEY_LEFTALT: 'Alt', KEY_RIGHTALT: 'Alt',
  KEY_LEFTSHIFT: 'Shift', KEY_RIGHTSHIFT: 'Shift',
  KEY_LEFTMETA: 'Super', KEY_RIGHTMETA: 'Super',
};

/** Keys that are an action rather than a character. */
const NAMED: Record<string, string> = {
  KEY_ENTER: 'Enter', KEY_KPENTER: 'Enter', KEY_ESC: 'Esc', KEY_TAB: 'Tab',
  KEY_BACKSPACE: 'Backspace', KEY_DELETE: 'Delete', KEY_HOME: 'Home',
  KEY_END: 'End', KEY_PAGEUP: 'PageUp', KEY_PAGEDOWN: 'PageDown',
  KEY_UP: 'Up', KEY_DOWN: 'Down', KEY_LEFT: 'Left', KEY_RIGHT: 'Right',
  KEY_INSERT: 'Insert', KEY_CAPSLOCK: 'CapsLock',
};

/** Unshifted characters for the keys that produce one. */
const CHARS: Record<string, string> = {
  KEY_SPACE: ' ', KEY_MINUS: '-', KEY_EQUAL: '=', KEY_LEFTBRACE: '[',
  KEY_RIGHTBRACE: ']', KEY_SEMICOLON: ';', KEY_APOSTROPHE: "'", KEY_GRAVE: '`',
  KEY_BACKSLASH: '\\', KEY_COMMA: ',', KEY_DOT: '.', KEY_SLASH: '/',
};

/** What Shift turns those into. */
const SHIFTED: Record<string, string> = {
  '-': '_', '=': '+', '[': '{', ']': '}', ';': ':', "'": '"', '`': '~',
  '\\': '|', ',': '<', '.': '>', '/': '?',
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
};

/** The character a key produces, or null if it is not a character key. */
export function charFor(code: string, shift: boolean): string | null {
  const letter = /^KEY_([A-Z])$/.exec(code);
  if (letter) return shift ? letter[1] : letter[1].toLowerCase();
  const digit = /^KEY_([0-9])$/.exec(code);
  if (digit) return shift ? (SHIFTED[digit[1]] ?? digit[1]) : digit[1];
  const punct = CHARS[code];
  if (punct) return shift ? (SHIFTED[punct] ?? punct) : punct;
  return null;
}

const BUTTONS: Record<string, 'left' | 'right' | 'middle'> = {
  BTN_LEFT: 'left', BTN_RIGHT: 'right', BTN_MIDDLE: 'middle',
};

export interface CompileOptions {
  /** A gap longer than this becomes an explicit wait step. */
  pauseMs?: number;
  /** Clicks closer together than this are one double/triple click. */
  multiClickMs?: number;
  /** Screenshot filenames, consumed in click order. */
  shots?: string[];
}

/**
 * Compile raw events into steps.
 *
 * Key releases and auto-repeats are dropped: a demonstration is a sequence of
 * intentions, and holding a key down for 400ms is one intention. Modifiers are
 * tracked as state rather than emitted, because "Ctrl down, C, Ctrl up" is one
 * thing that happened and three things that were recorded.
 */
export function compile(events: RawEvent[], opts: CompileOptions = {}): Step[] {
  const pauseMs = opts.pauseMs ?? 1200;
  const multiClickMs = opts.multiClickMs ?? 400;
  const shots = [...(opts.shots ?? [])];

  const steps: Step[] = [];
  const held = new Set<string>();
  let typing: { text: string; at: number } | null = null;
  let lastAt = events.length ? events[0].t : 0;

  const flushTyping = () => {
    if (typing && typing.text) steps.push({ kind: 'type', text: typing.text, at: typing.at });
    typing = null;
  };

  /** A gap the demonstrator left on purpose — waiting for a dialog, a load. */
  const noteGap = (at: number) => {
    const gap = at - lastAt;
    lastAt = at;
    if (gap < pauseMs) return;
    flushTyping();
    steps.push({ kind: 'wait', ms: Math.round(gap), at });
  };

  for (const ev of events) {
    if (ev.kind === 'key') {
      const modifier = MODIFIERS[ev.code];
      if (modifier) {
        // State, not a step. Emitting a modifier on its own would turn every
        // chord into three unreadable lines.
        if (ev.value === 1) held.add(modifier);
        else if (ev.value === 0) held.delete(modifier);
        continue;
      }
      if (ev.value !== 1) continue; // releases and auto-repeat carry no intent

      noteGap(ev.t);

      // Shift alone is not a chord — it is how capitals are typed.
      const chordMods = [...held].filter((m) => m !== 'Shift');
      const named = NAMED[ev.code];
      const char = charFor(ev.code, held.has('Shift'));

      if (chordMods.length > 0) {
        flushTyping();
        const key = named ?? char?.toUpperCase() ?? ev.code.replace(/^KEY_/, '');
        const order = ['Ctrl', 'Alt', 'Shift', 'Super'];
        const mods = [...held].sort((a, b) => order.indexOf(a) - order.indexOf(b));
        steps.push({ kind: 'press', label: [...mods, key].join('+'), at: ev.t });
        continue;
      }

      if (named) {
        flushTyping();
        steps.push({ kind: 'press', label: named, at: ev.t });
        continue;
      }

      if (char !== null) {
        if (!typing) typing = { text: '', at: ev.t };
        typing.text += char;
      }
      continue;
    }

    if (ev.kind === 'button') {
      if (ev.value !== 1) continue;
      const button = BUTTONS[ev.code];
      if (!button) continue;
      noteGap(ev.t);
      flushTyping();

      // A second click in quick succession is a double-click, not two clicks —
      // and replaying it as two would open a file twice or lose a selection.
      const prev = steps[steps.length - 1];
      if (prev?.kind === 'click' && prev.button === button && ev.t - prev.at <= multiClickMs) {
        prev.count += 1;
        prev.at = ev.t;
        continue;
      }
      steps.push({ kind: 'click', button, count: 1, at: ev.t, shot: shots.shift() });
      continue;
    }

    if (ev.kind === 'scroll') {
      if (ev.value === 0) continue;
      noteGap(ev.t);
      flushTyping();
      const direction = ev.value > 0 ? 'up' : 'down';
      const prev = steps[steps.length - 1];
      // Scrolling is a stream of single notches; a person means "scroll down",
      // not "scroll down eleven times".
      if (prev?.kind === 'scroll' && prev.direction === direction) {
        prev.notches += Math.abs(ev.value);
        prev.at = ev.t;
        continue;
      }
      steps.push({ kind: 'scroll', direction, notches: Math.abs(ev.value), at: ev.t });
    }
  }

  flushTyping();
  return steps;
}

/** Everything typed, for the review the operator sees before anything is kept. */
export function typedRuns(steps: Step[]): string[] {
  return steps.filter((s): s is Extract<Step, { kind: 'type' }> => s.kind === 'type')
    .map((s) => s.text)
    .filter((t) => t.trim());
}

/** One readable line per step, for `:catchthis list`. */
export function describe(step: Step): string {
  switch (step.kind) {
    case 'type': return `type ${JSON.stringify(step.text)}`;
    case 'press': return `press ${step.label}`;
    case 'click': {
      const what = step.count === 2 ? 'double-click' : step.count > 2 ? `${step.count}× click` : 'click';
      return `${what} (${step.button})${step.shot ? ` — see ${step.shot}` : ''}`;
    }
    case 'scroll': return `scroll ${step.direction} ${step.notches}`;
    case 'wait': return `wait ${(step.ms / 1000).toFixed(1)}s`;
  }
}

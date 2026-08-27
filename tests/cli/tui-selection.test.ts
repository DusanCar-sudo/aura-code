import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The clipboard is a real subprocess (xclip/wl-copy). Stub it so the tests
// assert on what Aura decided to copy, not on the developer's clipboard.
const copied = vi.hoisted(() => ({ text: '' as string, calls: 0 }));
vi.mock('../../src/tools/clipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/clipboard.js')>()),
  clipboardTool: async (input: { action: string; text?: string }) => {
    copied.calls++;
    copied.text = input.text ?? '';
    return `Copied ${input.text?.length ?? 0} characters to clipboard.`;
  },
}));

import {
  destroyTui, initTui, selectionRange, setBannerLines, startInput, writeOutput,
} from '../../src/cli/tui.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?<]*[A-Za-z~]/g, '');
}

/** SGR mouse report: ESC [ < btn ; col ; row (M press/drag, m release). */
const press   = (row: number) => `\x1b[<0;5;${row}M`;
const drag    = (row: number) => `\x1b[<32;5;${row}M`;
const release = (row: number) => `\x1b[<0;5;${row}m`;
const wheelUp   = (row: number) => `\x1b[<64;5;${row}M`;
const wheelDown = (row: number) => `\x1b[<65;5;${row}M`;

describe('TUI mouse selection', () => {
  const stdoutState = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
  };
  let chunks: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    chunks = [];
    copied.text = ''; copied.calls = 0;
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setBannerLines([]);
    initTui();
    startInput();
    for (let i = 1; i <= 40; i++) writeOutput(`line ${i}`);
    chunks = [];
  });

  afterEach(() => {
    destroyTui();
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (stdoutState.columns) Object.defineProperty(process.stdout, 'columns', stdoutState.columns);
    if (stdoutState.rows) Object.defineProperty(process.stdout, 'rows', stdoutState.rows);
  });

  it('starts a selection on press and grows it on drag', () => {
    process.stdin.emit('data', press(4));
    const start = selectionRange();
    expect(start).not.toBeNull();
    expect(start![0]).toBe(start![1]);      // one line at first

    process.stdin.emit('data', drag(8));
    const grown = selectionRange();
    expect(grown![1] - grown![0]).toBe(4);  // rows 4..8 inclusive
  });

  it('selects upward as well as downward', () => {
    process.stdin.emit('data', press(9));
    process.stdin.emit('data', drag(5));
    const r = selectionRange();
    // Normalised: lo <= hi regardless of drag direction.
    expect(r![0]).toBeLessThan(r![1]);
    expect(r![1] - r![0]).toBe(4);
  });

  it('copies the selected lines on release, with colour stripped', async () => {
    process.stdin.emit('data', press(4));
    process.stdin.emit('data', drag(6));
    process.stdin.emit('data', release(6));

    // The copy is fire-and-forget through a dynamic import, so it lands a
    // few microtasks later rather than on the keystroke.
    await vi.waitFor(() => expect(copied.calls).toBe(1));
    const lines = copied.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(copied.text).not.toMatch(/\x1b/);
    expect(lines.every(l => /^line \d+$/.test(l))).toBe(true);
  });

  it('scrolls the window when the drag reaches the top edge — the point of the feature', () => {
    process.stdin.emit('data', press(10));
    const before = selectionRange()![0];

    // Row 1 is the first content row with no banner: repeated drags there
    // must walk the view backwards through the buffer.
    for (let i = 0; i < 5; i++) process.stdin.emit('data', drag(1));

    const after = selectionRange()![0];
    expect(after).toBeLessThan(before);
    expect(stripAnsi(chunks.join(''))).toMatch(/-- SELECT --/);
  });

  it('does not scroll past the start of the buffer', () => {
    process.stdin.emit('data', press(6));
    for (let i = 0; i < 200; i++) process.stdin.emit('data', drag(1));
    expect(selectionRange()![0]).toBe(0);
  });

  it('shows a live line count while selecting, then the copy confirmation', async () => {
    process.stdin.emit('data', press(4));
    process.stdin.emit('data', drag(7));
    expect(stripAnsi(chunks.join(''))).toMatch(/4 lines · release to copy/);

    chunks = [];
    process.stdin.emit('data', release(7));
    await vi.waitFor(() => {
      expect(stripAnsi(chunks.join(''))).toMatch(/-- COPIED --.*copied 4 lines/);
    });
  });

  it('highlights the selected rows with reverse video', () => {
    chunks = [];
    process.stdin.emit('data', press(4));
    process.stdin.emit('data', drag(5));
    expect(chunks.join('')).toContain('\x1b[7m');
    expect(chunks.join('')).toContain('\x1b[27m');
  });

  it('ignores a press on the pinned bottom block', () => {
    process.stdin.emit('data', press(23));   // inside FIXED_BOTTOM on a 24-row terminal
    expect(selectionRange()).toBeNull();
  });

  it('scrolls on the wheel without needing a selection', () => {
    process.stdin.emit('data', wheelUp(5));
    const out = stripAnsi(chunks.join(''));
    expect(out).toMatch(/-- SCROLL --/);
    expect(selectionRange()).toBeNull();

    process.stdin.emit('data', wheelDown(5));
    expect(selectionRange()).toBeNull();
  });

  it('clears the selection when leaving scroll mode', () => {
    process.stdin.emit('data', press(4));
    process.stdin.emit('data', drag(6));
    expect(selectionRange()).not.toBeNull();

    process.stdin.emit('data', 'i');   // back to insert
    expect(selectionRange()).toBeNull();
  });

  it('does not wedge the input buffer on a mouse report', () => {
    // The generic CSI regex cannot match '<', so an unparsed report would sit
    // at the head of the buffer and swallow every later keystroke.
    process.stdin.emit('data', press(4));
    process.stdin.emit('data', release(4));
    chunks = [];
    process.stdin.emit('data', 'i');
    process.stdin.emit('data', 'x');
    expect(stripAnsi(chunks.join(''))).toContain('x');
  });

  it('survives a report split across two reads', () => {
    process.stdin.emit('data', '\x1b[<0;5;');
    expect(selectionRange()).toBeNull();     // incomplete: nothing yet
    process.stdin.emit('data', '4M');
    expect(selectionRange()).not.toBeNull(); // completed on the second read
  });
});

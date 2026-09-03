import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The clipboard is a real subprocess (xclip/wl-copy). Stub it so the tests
// assert on what Aura decided to copy, not on the developer's clipboard.
const copied = vi.hoisted(() => ({ text: '' as string, calls: 0 }));
const clip = vi.hoisted(() => ({ contents: null as string | null }));
vi.mock('../../src/tools/clipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/clipboard.js')>()),
  clipboardTool: async (input: { action: string; text?: string }) => {
    copied.calls++;
    copied.text = input.text ?? '';
    return `Copied ${input.text?.length ?? 0} characters to clipboard.`;
  },
  readClipboardSync: () => clip.contents,
}));

import {
  destroyTui, initTui, selectionRange, setBannerLines, startInput, writeOutput,
} from '../../src/cli/tui.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?<]*[A-Za-z~]/g, '');
}

/** SGR mouse report: ESC [ < btn ; col ; row (M press/drag, m release).
 *  Columns are 1-based screen columns; the default of 5 lands mid-word, so
 *  tests wanting whole lines say so with an explicit column. */
const at = (btn: number, col: number, row: number, final: 'M' | 'm') => `\x1b[<${btn};${col};${row}${final}`;
const press    = (row: number, col = 1) => at(0, col, row, 'M');
const drag     = (row: number, col = 1) => at(32, col, row, 'M');
const release  = (row: number, col = 1) => at(0, col, row, 'm');
const wheelUp   = (row: number) => at(64, 5, row, 'M');
const wheelDown = (row: number) => at(65, 5, row, 'M');
const rightClick = (row: number) => at(2, 5, row, 'M');

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
    clip.contents = null;
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
    process.stdin.emit('data', press(4, 1));
    process.stdin.emit('data', drag(6, 7));   // col 7 = past the end of "line N"
    process.stdin.emit('data', release(6, 7));

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

  it('shows the select banner while selecting, then the copy confirmation', async () => {
    process.stdin.emit('data', press(4, 1));
    process.stdin.emit('data', drag(7, 1));
    expect(stripAnsi(chunks.join(''))).toMatch(/-- SELECT --.*release to copy/);

    chunks = [];
    process.stdin.emit('data', release(7, 1));
    await vi.waitFor(() => {
      expect(stripAnsi(chunks.join(''))).toMatch(/-- COPIED --.*copied \d+ chars/);
    });
  });

  it('copies exactly the highlighted characters on one line, not the whole line', async () => {
    // "line 4": columns 2-4 spell "ine".
    process.stdin.emit('data', press(4, 2));
    process.stdin.emit('data', drag(4, 4));
    process.stdin.emit('data', release(4, 4));
    await vi.waitFor(() => expect(copied.calls).toBe(1));
    expect(copied.text).toBe('ine');
  });

  it('a multi-line selection takes partial first and last lines, whole middle ones', async () => {
    // The view is bottom-anchored, so which line numbers sit under rows 4-6
    // depends on the buffer — what the assertion pins is the shape: a partial
    // tail of the first line, a whole middle line, a partial head of the last.
    process.stdin.emit('data', press(4, 5));
    process.stdin.emit('data', drag(6, 3));
    process.stdin.emit('data', release(6, 3));
    await vi.waitFor(() => expect(copied.calls).toBe(1));
    expect(copied.text).toMatch(/^ \d+\nline \d+\nlin$/);
  });

  it('selecting backwards copies the same characters as forwards', async () => {
    // Anchor at the later line, drag up to the earlier one — the copy is the
    // normalised range, identical to dragging the other way.
    process.stdin.emit('data', press(6, 3));
    process.stdin.emit('data', drag(4, 5));
    process.stdin.emit('data', release(4, 5));
    await vi.waitFor(() => expect(copied.calls).toBe(1));
    expect(copied.text).toMatch(/^ \d+\nline \d+\nlin$/);
  });

  it('paints only the selected columns on the boundary lines', () => {
    chunks = [];
    process.stdin.emit('data', press(4, 2));
    process.stdin.emit('data', drag(4, 4));
    const out = chunks.join('');
    // Reverse video wraps just "ine"; the rest of the row stays plain.
    expect(out).toMatch(/l\x1b\[7mine\x1b\[27m \d+/);
    expect(out).not.toMatch(/\x1b\[7mline \d+/);
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

  it('right-click copies the current selection', async () => {
    process.stdin.emit('data', press(4));
    process.stdin.emit('data', drag(6));
    process.stdin.emit('data', drag(6));   // stay held; no release
    expect(selectionRange()).not.toBeNull();

    process.stdin.emit('data', rightClick(6));
    await vi.waitFor(() => expect(copied.calls).toBe(1));
    expect(copied.text.split('\n')).toHaveLength(3);
  });

  it('right-click with no selection pastes the clipboard into the input', () => {
    clip.contents = 'pasted text';
    chunks = [];
    process.stdin.emit('data', rightClick(20));
    expect(copied.calls).toBe(0);
    expect(stripAnsi(chunks.join(''))).toContain('pasted text');
  });

  it('a stray wheel tick just after leaving scroll mode does not re-enter it', () => {
    process.stdin.emit('data', wheelUp(5));            // enter scroll mode
    expect(stripAnsi(chunks.join(''))).toMatch(/-- SCROLL --/);
    process.stdin.emit('data', 'i');                   // back to insert
    chunks = [];

    process.stdin.emit('data', wheelUp(5));            // trailing detent
    expect(stripAnsi(chunks.join(''))).not.toMatch(/-- SCROLL --/);

    vi.advanceTimersByTime(600);   // past the re-entry grace window
    process.stdin.emit('data', wheelUp(5));            // deliberate, after the grace window
    expect(stripAnsi(chunks.join(''))).toMatch(/-- SCROLL --/);
  });

  it('survives a report split across two reads', () => {
    process.stdin.emit('data', '\x1b[<0;5;');
    expect(selectionRange()).toBeNull();     // incomplete: nothing yet
    process.stdin.emit('data', '4M');
    expect(selectionRange()).not.toBeNull(); // completed on the second read
  });
});

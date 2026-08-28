import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTuiDisplay, destroyTui, initTui, enterAltScreen,
  startInput, stopInput,
} from '../../src/cli/tui.js';

/**
 * Mouse reporting is handed back to the terminal whenever the TUI gives up
 * stdin.
 *
 * The bug this pins: `enterAltScreen` turned on SGR mouse reporting
 * (DECSET 1002 + 1006) and only `leaveAltScreen` turned it off — but every
 * overlay (the model selector, the provider wizard, an API-key or base-URL
 * prompt) takes stdin via stopInput() without leaving the alt screen. Only the
 * TUI's own handler decodes mouse reports, so while an overlay was reading,
 * each click or drag arrived there as a burst of junk keypresses — the
 * highlight jumping, escape bytes landing inside a filter or a pasted key —
 * and 1002 simultaneously suppressed the terminal's own text selection, so
 * nothing on screen could be selected or copied.
 */
describe('mouse reporting across stdin handoff', () => {
  const stdoutState = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
  };
  let chunks: string[] = [];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let savedIsTTY: PropertyDescriptor | undefined;

  const ENABLE = '\x1b[?1002h\x1b[?1006h';
  const DISABLE = '\x1b[?1006l\x1b[?1002l';
  const out = () => chunks.join('');

  beforeEach(() => {
    chunks = [];
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 });
    savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    // Not a TTY: setRawMode is skipped, but every escape sequence is still written.
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    initTui(createTuiDisplay());
  });

  afterEach(() => {
    stopInput();
    destroyTui();
    writeSpy.mockRestore();
    if (stdoutState.columns) Object.defineProperty(process.stdout, 'columns', stdoutState.columns);
    if (stdoutState.rows) Object.defineProperty(process.stdout, 'rows', stdoutState.rows);
    if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY);
  });

  it('turns reporting on when the alt screen opens', () => {
    enterAltScreen();
    expect(out()).toContain(ENABLE);
  });

  it('turns reporting off when an overlay takes stdin', () => {
    enterAltScreen();
    startInput();
    chunks = [];
    stopInput();
    expect(out()).toContain(DISABLE);
  });

  it('turns reporting back on when the TUI takes stdin again', () => {
    enterAltScreen();
    startInput();
    stopInput();
    chunks = [];
    startInput();
    expect(out()).toContain(ENABLE);
  });

  it('does not enable reporting outside the alt screen', () => {
    // Inline mode never asked for mouse events; startInput must not introduce
    // them, or a plain terminal session loses its native selection.
    startInput();
    expect(out()).not.toContain(ENABLE);
  });
});

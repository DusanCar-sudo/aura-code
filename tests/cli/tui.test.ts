import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBannerLines } from '../../src/cli/diamond.js';
import {
  createTuiDisplay,
  destroyTui,
  initTui,
  setBannerLines,
  setStatusLine,
  startInput,
  stopInput,
  writeOutput,
} from '../../src/cli/tui.js';

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

describe('TUI cursor preservation', () => {
  const stdoutState = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
  };

  let chunks: string[] = [];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    chunks = [];
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 });
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    try {
      setBannerLines([]);
      stopInput();
      destroyTui();
    } catch {
      // Best-effort cleanup for module-level TUI state.
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    writeSpy.mockRestore();

    if (stdoutState.columns) {
      Object.defineProperty(process.stdout, 'columns', stdoutState.columns);
    }
    if (stdoutState.rows) {
      Object.defineProperty(process.stdout, 'rows', stdoutState.rows);
    }
  });

  it('wraps prompt redraws in save/restore cursor sequences', () => {
    initTui();
    startInput();
    chunks = [];

    setStatusLine('streaming reply');

    const output = chunks.join('');
    expect(output).toMatch(/\x1b\[s[\s\S]*\x1b\[u/);
  });

  it('renders the thinking spinner without leaving the cursor on the spinner row', () => {
    initTui();
    const display = createTuiDisplay();
    chunks = [];

    display.agentThinking();
    vi.advanceTimersByTime(120);

    const output = chunks.join('');
    expect(output).toMatch(/\x1b\[s[\s\S]*thinking[\s\S]*\x1b\[u/);
  });

  it('renders the tool spinner without overwriting the active stream cursor', () => {
    initTui();
    const display = createTuiDisplay();
    chunks = [];

    display.toolStart('run_shell', 'tool-1');
    vi.advanceTimersByTime(120);

    const output = chunks.join('');
    expect(output).toMatch(/\x1b\[s[\s\S]*run_shell[\s\S]*\x1b\[u/);
  });

  it('accepts non-ASCII printable letters in the input box', () => {
    initTui();
    startInput();
    chunks = [];

    process.stdin.emit('data', 'ж');

    const output = chunks.join('');
    expect(output).toContain('ж');
  });

  it('starts the scroll region below the banner when banner rows are present', () => {
    setBannerLines(['banner-1', 'banner-2', 'banner-3']);

    initTui();

    const output = chunks.join('');
    expect(output).toContain('\x1b[4;17r');
    expect(output).toContain('\x1b[4;1H');
  });

  it('stretches the input box with the terminal width', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 140 });

    initTui();
    startInput();

    const plain = stripAnsi(chunks.join(''));
    const promptLine = plain.match(/  ╭ ask aura .*?╮/)?.[0];

    expect(promptLine).toBeTruthy();
    expect(promptLine?.length).toBe(139);
  });

  it('stretches the banner rule with the terminal width', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 140 });

    const lines = buildBannerLines({ version: '0.0.0', cwd: '/tmp' });
    const rule = stripAnsi(lines.at(-1) ?? '');

    expect(rule.length).toBe(140);
  });

  it('returns the cursor to the output region after leaving scroll mode', () => {
    initTui();
    startInput();
    writeOutput('one line');
    chunks = [];

    process.stdin.emit('data', '\x1b');
    process.stdin.emit('data', 'i');

    const output = chunks.join('');
    expect(output).toContain('\x1b[17;1H');
  });
});

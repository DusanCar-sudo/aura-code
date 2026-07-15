import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBannerLines } from '../../src/cli/diamond.js';
import {
  createTuiDisplay,
  destroyTui,
  initTui,
  setBannerLines,
  setCallbacks,
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

  it('returns prompt redraws to the output region', () => {
    initTui();
    startInput();
    chunks = [];

    setStatusLine('streaming reply');

    const output = chunks.join('');
    expect(output).toContain('\x1b[17;1H');
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

  it('rebuilds the scroll region when the terminal is resized', () => {
    initTui();
    startInput();
    chunks = [];

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    process.stdout.emit('resize');

    const output = chunks.join('');
    expect(output).toContain('\x1b[1;23r');
    expect(output).toContain('\x1b[2J\x1b[H');
    expect(output).toContain('\x1b[23;1H');
  });

  it('preserves in-flight streamed text across a terminal resize redraw', () => {
    initTui();
    startInput();
    const display = createTuiDisplay();

    display.streamText('partial stream');
    chunks = [];

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 90 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 28 });
    process.stdout.emit('resize');

    const plain = stripAnsi(chunks.join(''));
    expect(plain).toContain('partial stream');
  });

  it('clears the previous prompt footprint before redrawing the bottom pane', () => {
    initTui();
    startInput();
    chunks = [];

    setStatusLine('first');
    setStatusLine('second');

    const output = chunks.join('');
    expect(output).toContain('\x1b[18;1H\x1b[0K');
    expect(output).toContain('\x1b[24;1H\x1b[0K');
  });

  it('buffers split escape sequences instead of leaking CSI fragments into the prompt', () => {
    initTui();
    startInput();
    chunks = [];

    process.stdin.emit('data', '\x1b[');
    process.stdin.emit('data', 'A');

    const output = stripAnsi(chunks.join(''));
    expect(output).not.toContain('[');
    expect(output).not.toContain('A');
  });

  it('collapses a multi-line bracketed paste into a placeholder and expands it on submit', () => {
    initTui();
    startInput();
    let submitted = '';
    setCallbacks({ onEnter: line => { submitted = line; } });
    chunks = [];

    const pasted = Array.from({ length: 19 }, (_, i) => `line ${i + 1}`).join('\n');
    process.stdin.emit('data', `\x1b[200~${pasted}\x1b[201~`);

    const output = stripAnsi(chunks.join(''));
    expect(output).toContain('[Pasted #');
    expect(output).toContain('19 lines]');
    expect(output).not.toContain('line 5\nline 6');

    process.stdin.emit('data', '\r');
    expect(submitted).toBe(pasted);
  });

  it('handles a bracketed paste whose end marker arrives in a later chunk', () => {
    initTui();
    startInput();
    let submitted = '';
    setCallbacks({ onEnter: line => { submitted = line; } });

    process.stdin.emit('data', '\x1b[200~first\nsec');
    process.stdin.emit('data', 'ond\x1b[20');
    process.stdin.emit('data', '1~');
    process.stdin.emit('data', '\r');

    expect(submitted).toBe('first\nsecond');
  });

  it('inserts short single-line pastes literally without a placeholder', () => {
    initTui();
    startInput();
    let submitted = '';
    setCallbacks({ onEnter: line => { submitted = line; } });
    chunks = [];

    process.stdin.emit('data', '\x1b[200~npm run build\x1b[201~');

    const output = stripAnsi(chunks.join(''));
    expect(output).toContain('npm run build');
    expect(output).not.toContain('[Pasted');

    process.stdin.emit('data', '\r');
    expect(submitted).toBe('npm run build');
  });

  it('does not treat newlines inside a paste as Enter presses', () => {
    initTui();
    startInput();
    const submissions: string[] = [];
    setCallbacks({ onEnter: line => { submissions.push(line); } });

    process.stdin.emit('data', '\x1b[200~a\nb\nc\x1b[201~');

    expect(submissions).toEqual([]);
  });

  it('deletes a paste placeholder atomically on backspace', () => {
    initTui();
    startInput();
    let submitted = '';
    setCallbacks({ onEnter: line => { submitted = line; } });

    process.stdin.emit('data', '\x1b[200~a\nb\nc\x1b[201~');
    process.stdin.emit('data', '\x7f'); // backspace removes whole placeholder
    process.stdin.emit('data', 'ok');
    process.stdin.emit('data', '\r');

    expect(submitted).toBe('ok');
  });

  it('exits scroll mode automatically and inputs character when typing a printable key', () => {
    initTui();
    startInput();
    writeOutput('some output'); // ensure scrollBuffer is not empty
    chunks = [];

    process.stdin.emit('data', '\x1b'); // enter scroll mode
    process.stdin.emit('data', 'a'); // type 'a' (printable key)

    const output = chunks.join('');
    // It should have exited scroll mode and drawn the prompt with the input 'a'
    expect(output).toContain('a');
    // Ensure we are back in insert mode / returned cursor to output region
    expect(output).toContain('\x1b[17;1H');
  });
});

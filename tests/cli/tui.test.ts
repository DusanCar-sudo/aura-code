import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBannerLines } from '../../src/cli/diamond.js';
import {
  clearInputHistory,
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

  // ── v0.12.2 scroll-mode regressions ──────────────────────────────────────

  it('treats SS3 arrow keys as arrows, not Escape plus stray letters', () => {
    // Terminals in application-cursor mode send \x1bOA for Up. That fell through
    // to the bare-Escape branch: Escape entered scroll mode and "O"/"A" were
    // typed into the input as literal text.
    initTui();
    startInput();
    process.stdin.emit('data', 'hello');
    chunks = [];

    process.stdin.emit('data', '\x1bOA');

    const output = chunks.join('');
    expect(output).not.toContain('-- SCROLL --');
    expect(stripAnsi(output)).not.toMatch(/hello[OA]/);
  });

  it('waits for the final byte of a split SS3 sequence', () => {
    initTui();
    startInput();
    process.stdin.emit('data', 'hi');
    chunks = [];

    // Arrow-Left, because Arrow-Down now opens scroll mode on purpose — a
    // torn read misparsed as a bare Esc is what must not open it here.
    process.stdin.emit('data', '\x1bO');   // torn read — no final byte yet
    process.stdin.emit('data', 'D');

    const output = chunks.join('');
    expect(output).not.toContain('-- SCROLL --');
    expect(stripAnsi(output)).not.toMatch(/hi[OD]/);
  });

  it('treats ESC+letter as Alt/Meta, not Escape then a stray key', () => {
    // xterm encodes Alt+j as "\x1bj" in one read. The bare-Escape branch used
    // to flip on the pager and then feed "j" to scroll-mode key handling —
    // "I type one letter and land in scroll".
    initTui();
    startInput();
    process.stdin.emit('data', 'hi');
    chunks = [];

    process.stdin.emit('data', '\x1bj');

    const output = chunks.join('');
    expect(output).not.toContain('-- SCROLL --');
    expect(stripAnsi(output)).toContain('hij');   // the letter still types
  });

  it('types q when leaving scroll mode instead of swallowing it', () => {
    initTui();
    startInput();
    writeOutput('one line');
    // Down-arrow on an empty input enters scroll mode directly. (Entering via
    // a lone Esc would leave a second Esc buffered, which exits again.)
    process.stdin.emit('data', '\x1b[B');
    chunks = [];

    process.stdin.emit('data', 'q');

    expect(stripAnsi(chunks.join(''))).toContain('q');
  });

  it('still treats i as the documented insert command, not text', () => {
    // The scroll indicator advertises "i/Enter/Esc insert", so i must not type.
    initTui();
    startInput();
    writeOutput('one line');
    process.stdin.emit('data', '\x1b[B');
    chunks = [];

    process.stdin.emit('data', 'i');

    // Leaves scroll mode without inserting the character into the input box.
    const box = stripAnsi(chunks.join('')).match(/\u2502 ([^\u2502]*)/);
    expect(box?.[1] ?? '').not.toMatch(/^i/);
  });

  it('applies a resize that arrived while an overlay held the screen', () => {
    initTui();
    startInput();
    stopInput();                       // overlay takes the screen
    chunks = [];

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    process.stdout.emit('resize');
    expect(chunks.join('')).toBe('');  // dropped while inactive…

    startInput();                      // …and replayed on resume
    expect(chunks.join('')).toContain('\x1b[1;23r');
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

describe('input-box history', () => {
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

  const submit = (line: string) => {
    for (const ch of line) process.stdin.emit('data', ch);
    process.stdin.emit('data', '\r');
    chunks = [];
  };

  beforeEach(() => {
    // The history is module state and outlives destroyTui — without this,
    // earlier tests' submissions leak into later recall assertions.
    clearInputHistory();
  });

  it('Arrow-Up recalls the last line submitted from the box', () => {
    initTui();
    startInput();
    submit(':model glm-5.3-flash');

    process.stdin.emit('data', '\x1b[A');

    expect(chunks.join('')).toContain(':model glm-5.3-flash');
  });

  it('repeated Arrow-Up walks back through history instead of scrolling', () => {
    initTui();
    startInput();
    writeOutput('scrollback line so scroll mode has something to show');
    submit('first task');
    submit('second task');

    process.stdin.emit('data', '\x1b[A');
    chunks = [];
    process.stdin.emit('data', '\x1b[A');
    const output = chunks.join('');
    expect(output).toContain('first task');
    expect(output).not.toContain('-- SCROLL --');
  });

  it('Arrow-Up stops at the oldest of the last 10 lines', () => {
    initTui();
    startInput();
    for (let i = 0; i < 12; i++) submit(`task ${i}`);

    for (let i = 0; i < 9; i++) process.stdin.emit('data', '\x1b[A');
    chunks = [];
    process.stdin.emit('data', '\x1b[A');
    expect(chunks.join('')).toContain('task 2');

    // One more Up has nowhere to go — task 1 and task 0 fell off the end.
    chunks = [];
    process.stdin.emit('data', '\x1b[A');
    expect(chunks.join('')).not.toContain('task 1');
    expect(chunks.join('')).not.toContain('-- SCROLL --');
  });

  it('Arrow-Down walks forward, then restores the box without scroll mode', () => {
    initTui();
    startInput();
    writeOutput('scrollback line so scroll mode has something to show');
    submit('older task');
    submit('newer task');

    process.stdin.emit('data', '\x1b[A');
    process.stdin.emit('data', '\x1b[A');
    chunks = [];
    process.stdin.emit('data', '\x1b[B');
    expect(chunks.join('')).toContain('newer task');

    chunks = [];
    process.stdin.emit('data', '\x1b[B');
    const output = chunks.join('');
    expect(output).not.toContain('-- SCROLL --');
    expect(output).not.toContain('│ newer task');
  });

  it('Arrow-Down with no recall on show opens scroll mode', () => {
    initTui();
    startInput();
    for (let i = 0; i < 25; i++) writeOutput(`scrollback line ${i}`);
    submit('some task');

    process.stdin.emit('data', '\x1b[B');

    expect(chunks.join('')).toContain('-- SCROLL --');
  });

  it('typing after a recall ends browsing, so a later Arrow-Up leaves the edit alone', () => {
    initTui();
    startInput();
    submit('task zero');
    submit('task one');

    process.stdin.emit('data', '\x1b[A');
    process.stdin.emit('data', 'x');
    chunks = [];
    process.stdin.emit('data', '\x1b[A');
    expect(chunks.join('')).not.toContain('-- SCROLL --');
    expect(chunks.join('')).not.toContain('task zero');

    // The edit is still in the box: one more character redraws it intact.
    process.stdin.emit('data', 'y');
    expect(chunks.join('')).toContain('task onexy');
  });

  it('Arrow-Up never opens scroll mode, even with nothing submitted', () => {
    initTui();
    startInput();
    for (let i = 0; i < 25; i++) writeOutput(`scrollback line ${i}`);
    chunks = [];

    process.stdin.emit('data', '\x1b[A');

    expect(chunks.join('')).not.toContain('-- SCROLL --');
  });

  it('a second submit of the same line is not recorded twice', () => {
    initTui();
    startInput();
    submit('other line');
    submit('same line');
    submit('same line');
    // Two Ups land on the entry before the duplicate, not on its twin.
    process.stdin.emit('data', '\x1b[A');
    chunks = [];
    process.stdin.emit('data', '\x1b[A');

    expect(chunks.join('')).toContain('other line');
  });
});

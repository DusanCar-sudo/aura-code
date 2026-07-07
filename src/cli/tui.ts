/**
 * TUI — Terminal User Interface with fixed bottom input line.
 *
 * Manages a split-terminal layout using absolute cursor positioning:
 *   • Output area: rows 0 to (rows - INPUT_LINES)
 *   • Input area: bottom INPUT_LINES rows, always pinned, ruby red frame
 *
 * The user can type at any time. Commands like :btw buffer during responses.
 */
import chalk from 'chalk';
import type { Display } from './display.js';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';

// ── State ──────────────────────────────────────────────────────────────────

let cols = process.stdout.columns ?? 80;
let rows = process.stdout.rows ?? 24;
let inputBuffer = '';
let cursorPos = 0;
let inputActive = false;
let stdinHandler: ((data: string) => void) | null = null;
let chatId = '';

let onEnter: ((line: string) => void) | null = null;
let onStop: (() => void) | null = null;

const INPUT_LINES = 4;
const FIELD_WIDTH = () => Math.min(cols, 100) - 4;
let currentAbort: AbortController | null = null;

process.stdout.on('resize', () => {
  cols = process.stdout.columns ?? 80;
  rows = process.stdout.rows ?? 24;
  if (inputActive) drawInputFrame();
});

// ── Low-level terminal control ─────────────────────────────────────────────

/** Move cursor to (row, col), 1-indexed. Row 1 = top of terminal. */
function goto(row: number, col = 1): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

function clearEol(): void {
  process.stdout.write('\x1b[0K');
}

function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

function showCursor(): void {
  process.stdout.write('\x1b[?25h');
}

// ── AbortController management ─────────────────────────────────────────────

export function createAbortController(): AbortController {
  currentAbort = new AbortController();
  return currentAbort;
}

export function clearAbortController(): void {
  currentAbort = null;
}

// ── Input frame rendering ──────────────────────────────────────────────────

/** Draw the 4-line input frame at the bottom of the terminal. */
function drawInputFrame(): void {
  const w = FIELD_WIDTH();
  const idTag = chatId ? ` ${chatId}` : '';
  const label = ` ask aura${idTag} `;
  const dashes = Math.max(0, w - label.length - 1);
  const displayText = inputBuffer;
  const isEmpty = displayText.length === 0;
  const inputRow = rows - INPUT_LINES + 1; // 1-indexed, first row of the input area

  // Line 1: spacer (empty)
  goto(inputRow, 1);
  clearEol();

  // Line 2: top border
  goto(inputRow + 1, 1);
  clearEol();
  process.stdout.write('  ' + chalk.hex('#9b1b30')('╭' + chalk.hex('#8a7768')(label) + '─'.repeat(dashes) + '╮'));

  // Line 3: prompt line
  goto(inputRow + 2, 1);
  clearEol();
  const prompt = chalk.hex('#9b1b30')('╰ ') + chalk.hex('#cc785c').bold('❯ ');
  const placeholder = isEmpty ? chalk.hex('#4e3d30')('type a task, :btw, :q, :help...  ') : '';
  const cursorChar = chalk.hex('#cc785c')('█');

  if (isEmpty) {
    process.stdout.write('  ' + prompt + placeholder + cursorChar);
  } else {
    const before = chalk.hex('#ede0cc')(displayText.slice(0, cursorPos));
    const at = cursorChar;
    const after = chalk.hex('#ede0cc')(displayText.slice(cursorPos));
    process.stdout.write('  ' + prompt + before + at + after);
  }

  // Line 4: bottom spacer
  goto(inputRow + 3, 1);
  clearEol();
}

// ── Output writing ─────────────────────────────────────────────────────────

/** Write one or more lines to the output area (above the input frame). */
export function writeOutput(text: string): void {
  // Find the first row of the input area
  const inputStart = rows - INPUT_LINES + 1;
  // Move cursor to the output area (just above the input frame)
  goto(inputStart - 1, 1);
  // If there's existing content on this line, we need to move further up
  // Write a newline to scroll, then go back up
  process.stdout.write('\n');
  goto(inputStart - 1, 1);
  clearEol();
  process.stdout.write(text);
  // Redraw the input frame
  drawInputFrame();
  // Place cursor at the prompt line for typing
  goto(inputStart + 2, 5 + promptPrefixLength());
}

function promptPrefixLength(): number {
  return 3 + 3; // "  ╰ " + "❯ " ≈ 6 visible chars
}

/** Write streaming text inline (no newline). */
export function writeStream(text: string): void {
  process.stdout.write(text);
}

// ── Input handling ─────────────────────────────────────────────────────────

function handleChar(ch: string): void {
  const inputStart = rows - INPUT_LINES + 1;

  // Ctrl+C → abort running task, or exit if idle
  if (ch === '\x03') {
    if (currentAbort && !currentAbort.signal.aborted) {
      currentAbort.abort();
      // Write abort message to output area
      goto(inputStart - 1, 1);
      process.stdout.write('\n' + chalk.hex('#d4903a')('  ⏹ Aborting current task...'));
      drawInputFrame();
      if (onStop) onStop();
      return;
    }
    showCursor();
    process.stdout.write('\n');
    process.exit(0);
  }

  // ENTER
  if (ch === '\r' || ch === '\n') {
    const line = inputBuffer.trim();
    inputBuffer = '';
    cursorPos = 0;
    drawInputFrame();
    if (line && onEnter) onEnter(line);
    return;
  }

  // BACKSPACE
  if (ch === '\x7f' || ch === '\b') {
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      drawInputFrame();
    }
    return;
  }

  // Ctrl+U — clear line
  if (ch === '\x15') {
    inputBuffer = '';
    cursorPos = 0;
    drawInputFrame();
    return;
  }

  // Printable
  if (ch >= ' ' && ch <= '~') {
    inputBuffer = inputBuffer.slice(0, cursorPos) + ch + inputBuffer.slice(cursorPos);
    cursorPos++;
    drawInputFrame();
    return;
  }
}

function rawHandler(data: string): void {
  for (const ch of data) handleChar(ch);
}

export function startInput(): void {
  if (inputActive) return;
  inputActive = true;
  inputBuffer = '';
  cursorPos = 0;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  stdinHandler = rawHandler;
  process.stdin.on('data', stdinHandler);
  drawInputFrame();
}

export function stopInput(): void {
  if (!inputActive) return;
  inputActive = false;
  if (stdinHandler) {
    process.stdin.removeListener('data', stdinHandler);
    stdinHandler = null;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

export function setCallbacks(opts: { onEnter: (line: string) => void; onStop?: () => void }): void {
  onEnter = opts.onEnter;
  onStop = opts.onStop ?? null;
}

export function setChatId(id: string): void {
  chatId = id;
}

export function initTui(): void {
  hideCursor();
  // Clear screen and reserve space
  process.stdout.write('\n'.repeat(INPUT_LINES));
  drawInputFrame();
  // Move cursor to the prompt line
  const inputStart = rows - INPUT_LINES + 1;
  goto(inputStart + 2, 5);
}

export function destroyTui(): void {
  stopInput();
  showCursor();
  process.stdout.write('\n');
}

// ── TUI-aware Display ──────────────────────────────────────────────────────

function toolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄', list_dir: '📁', edit_file: '✏️',
    write_file: '📝', search_code: '🔍', run_shell: '⚡',
    run_tests: '🧪', git_status: '🌿', git_diff: '📊',
  };
  return icons[name] ?? '🔧';
}

function fmtIn(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': {
      const r = input.start_line ? ` :${input.start_line}-${input.end_line ?? '?'}` : '';
      return `${input.path}${r}`;
    }
    case 'list_dir':   return `${input.path ?? '.'}${input.recursive ? ' (recursive)' : ''}`;
    case 'edit_file':  return `${input.path}`;
    case 'write_file': return `${input.path}`;
    case 'search_code': return `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
    case 'run_shell':  return String(input.command);
    case 'run_tests':  return input.file_or_pattern ? String(input.file_or_pattern) : 'all tests';
    case 'git_diff':   return input.path ? String(input.path) : 'all files';
    default:           return JSON.stringify(input).slice(0, 60);
  }
}

function sep(): string {
  return '─'.repeat(Math.min(cols, 60));
}

export function createTuiDisplay(): Display {
  let inStream = false;

  return {
    agentThinking() {},

    toolStart() {},

    streamText(text: string) {
      if (!inStream) {
        inStream = true;
        // Move to output area
        const inputStart = rows - INPUT_LINES + 1;
        goto(inputStart - 1, 1);
        process.stdout.write('\n');
        // Redraw input after we're done
      }
      writeStream(chalk.hex('#ede0cc')(text));
    },

    streamEnd() {
      if (inStream) {
        writeOutput('');
        inStream = false;
      }
    },

    toolCall(name: string, input: Record<string, unknown>) {
      const icon = toolIcon(name);
      const label = chalk.hex('#cc785c').bold(`${icon} ${name}`);
      const detail = fmtIn(name, input);
      writeOutput(`  ${label}  ${chalk.hex('#8a7768')(detail)}`);
    },

    toolResult(name: string, result: string, elapsedMs: number) {
      const lines = result.split('\n');
      const preview = lines.length > 8
        ? lines.slice(0, 8).join('\n') + chalk.hex('#4e3d30')(`\n  ... (${lines.length - 8} more lines)`)
        : result;
      const elapsed = chalk.hex('#4e3d30')(`${elapsedMs}ms`);
      const isError = result.startsWith('Error:') || result.startsWith('Tool error');
      if (isError) {
        writeOutput('  ' + chalk.hex('#b15439')('✗ ') + chalk.hex('#8a7768')(preview.replace(/\n/g, '\n    ')));
      } else {
        const fl = lines[0] ?? '';
        if (lines.length <= 3) {
          writeOutput('  ' + chalk.hex('#5a9e6e')('✓ ') + chalk.hex('#8a7768')(result));
        } else {
          writeOutput('  ' + chalk.hex('#5a9e6e')('✓ ') + chalk.hex('#8a7768')(`${fl}`) + chalk.hex('#4e3d30')(` (+${lines.length - 1} lines) ${elapsed}`));
        }
      }
    },

    toolBlocked(name: string, reason: string) {
      writeOutput('  ' + chalk.hex('#d4903a')(`⊘ ${name} blocked: ${reason}`));
    },

    warning(msg: string) {
      writeOutput('\n' + chalk.hex('#d4903a')(`  ⚠  ${msg}`));
    },

    success(msg: string) {
      writeOutput('\n' + chalk.hex('#5a9e6e')(`  ✓  ${msg}`));
    },

    error(msg: string) {
      writeOutput('\n' + chalk.hex('#b15439')(`  ✗  ${msg}`));
    },

    header(title: string, subtitle?: string) {
      const l = sep();
      writeOutput('\n' + chalk.hex('#4e3d30')(l));
      writeOutput(chalk.hex('#cc785c').bold(`  ${title}`));
      if (subtitle) writeOutput(chalk.hex('#8a7768')(`  ${subtitle}`));
      writeOutput(chalk.hex('#4e3d30')(l));
    },

    summary(text: string, turns: number, toolCount: number) {
      const l = sep();
      writeOutput('\n' + chalk.hex('#4e3d30')(l));
      writeOutput(chalk.hex('#5a9e6e').bold('  ✓ Done'));
      writeOutput(chalk.hex('#8a7768')(`  ${turns} turn${turns > 1 ? 's' : ''} · ${toolCount} tool call${toolCount > 1 ? 's' : ''}`));
      if (text) {
        writeOutput('');
        text.split('\n').forEach(lx => writeOutput(chalk.hex('#c8b5a0')(`  ${lx}`)));
      }
      writeOutput(chalk.hex('#4e3d30')(l) + '\n');
    },

    showPlan(plan: ExecutionPlan) {
      const l = sep();
      const idxMap = new Map<string, number>(plan.steps.map((s, i) => [s.id, i + 1]));
      writeOutput('\n' + chalk.hex('#4e3d30')(l));
      writeOutput(chalk.hex('#cc785c').bold('  Execution Plan'));
      writeOutput(chalk.hex('#8a7768')(`  Goal: ${plan.goal}`));
      writeOutput(chalk.hex('#4e3d30')(l));
      plan.steps.forEach((s, i) => {
        const num  = chalk.hex('#4e3d30')(`${i + 1}.`);
        const spec = chalk.hex('#cc785c').bold(`[${s.specialist}]`);
        const task = chalk.hex('#c8b5a0')(s.task.length > 55 ? s.task.slice(0, 52) + '…' : s.task);
        const deps = s.dependsOn.length > 0
          ? chalk.hex('#4e3d30')(` ← ${s.dependsOn.map(d => idxMap.get(d) ?? '?').join(', ')}`)
          : '';
        writeOutput(`  ${num} ${spec} ${task}${deps}`);
      });
      writeOutput(chalk.hex('#4e3d30')(l) + '\n');
    },

    stepStarted(step: PlanStep) {
      const spec = chalk.hex('#d4903a').bold(`[${step.specialist}]`);
      const task = chalk.hex('#8a7768')(step.task.length > 70 ? step.task.slice(0, 67) + '…' : step.task);
      writeOutput('\n' + chalk.hex('#d4903a')('  →') + ` ${spec} ${task}`);
    },

    stepCompleted(step: PlanStep) {
      const spec = chalk.hex('#5a9e6e').bold(`[${step.specialist}]`);
      const ms   = step.durationMs != null ? `${step.durationMs}ms` : '?ms';
      writeOutput(chalk.hex('#5a9e6e')('  ✓') + ` ${spec} ${chalk.hex('#4e3d30')(`done (${ms})`)}`);
    },

    retry(info) {
      const secs = (info.delayMs / 1000).toFixed(1);
      writeOutput(chalk.hex('#d4903a')(`  ⟳ ${info.provider} retrying in ${secs}s (attempt ${info.attempt}) — ${info.reason}`));
    },

    failover(info) {
      writeOutput(chalk.hex('#d4903a')(`  ⤳ Failing over ${info.from} → ${info.to} (${info.reason})`));
    },

    circuit(info) {
      const colour = info.state === 'open' ? '#b15439' : info.state === 'half-open' ? '#d4903a' : '#5a9e6e';
      writeOutput(chalk.hex(colour)(`  ◯ Circuit ${info.provider}: ${info.state}`));
    },
  };
}

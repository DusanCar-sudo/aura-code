/**
 * TUI — Terminal User Interface with fixed bottom input line.
 *
 * Manages a split-terminal layout:
 *   • Top area: scrollable output (agent responses, tool calls, etc.)
 *   • Bottom area: fixed input line with the ruby red frame, always visible
 *
 * The user can type at any time, even while the agent is responding.
 * Commands like :btw and :stop are buffered and processed accordingly.
 */
import chalk from 'chalk';
import type { Display } from './display.js';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';

// ── ANSI helpers ───────────────────────────────────────────────────────────

const CSI = '\x1b[';
const savePos  = () => process.stdout.write(CSI + 's');
const restPos  = () => process.stdout.write(CSI + 'u');
const cursorUp    = (n: number) => { if (n > 0) process.stdout.write(CSI + n + 'A'); };
const cursorDown  = (n: number) => { if (n > 0) process.stdout.write(CSI + n + 'B'); };
const cursorCol   = (n: number) => process.stdout.write(CSI + n + 'G');
const clearLine   = () => process.stdout.write(CSI + '0K');
const clearDown   = () => process.stdout.write(CSI + '0J');
const hideCursor  = () => process.stdout.write(CSI + '?25l');
const showCursor  = () => process.stdout.write(CSI + '?25h');

// ── State ──────────────────────────────────────────────────────────────────

let cols = process.stdout.columns ?? 80;
let rows = process.stdout.rows ?? 24;
let inputBuffer = '';
let cursorPos = 0;
let inputActive = false;
let stdinHandler: ((chunk: string) => void) | null = null;
let chatId = '';

// Callbacks set by the REPL
let onEnter: ((line: string) => void) | null = null;
let onStop: (() => void) | null = null;

const INPUT_LINES = 4;
const FIELD_WIDTH = () => Math.min(cols, 100) - 4;

process.stdout.on('resize', () => {
  cols = process.stdout.columns ?? 80;
  rows = process.stdout.rows ?? 24;
  if (inputActive) drawInputLine();
});

export function setChatId(id: string): void { chatId = id; }

// ── Input line rendering ───────────────────────────────────────────────────

function drawInputLine(): void {
  const w = FIELD_WIDTH();
  const idTag = chatId ? ` ${chatId}` : '';
  const label = ` ask aura${idTag} `;
  const dashes = Math.max(0, w - label.length - 1);
  const displayText = inputBuffer;
  const isEmpty = displayText.length === 0;

  // Save cursor, move to bottom line area, draw 4 lines, restore cursor
  savePos();
  // Move to the bottom of the terminal
  cursorDown(rows);
  // Go up INPUT_LINES to reach the top of our input area
  cursorUp(INPUT_LINES);

  // Line 1: spacer
  clearLine();
  process.stdout.write('\n');

  // Line 2: top border — ruby red frame
  clearLine();
  process.stdout.write('  ' + chalk.hex('#9b1b30')('╭' + chalk.hex('#8a7768')(label) + '─'.repeat(dashes) + '╮'));
  process.stdout.write('\n');

  // Line 3: prompt line with input
  clearLine();
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
  process.stdout.write('\n');

  // Line 4: bottom spacer
  clearLine();

  restPos();
}

// ── Output writing ─────────────────────────────────────────────────────────

/**
 * Write a line to the output area above the fixed input line.
 */
export function writeOutput(text: string): void {
  savePos();
  // Move cursor up above the input frame
  cursorUp(INPUT_LINES);
  // If the cursor is in the input area, this puts us in the output area
  clearLine();
  process.stdout.write(text);
  process.stdout.write('\n');
  // Ensure we're not scrolled into the input area
  // Redraw input
  restPos();
  if (inputActive) drawInputLine();
}

/**
 * Write text inline (used during streaming).
 */
export function writeStream(text: string): void {
  process.stdout.write(text);
}

// ── Input handling ─────────────────────────────────────────────────────────

function handleChar(ch: string): void {
  // Ctrl+C → stop current task or exit
  if (ch === '\x03') {
    if (onStop) { onStop(); return; }
    process.stdout.write('\n');
    process.exit(0);
  }
  // ENTER
  if (ch === '\r' || ch === '\n') {
    const line = inputBuffer.trim();
    inputBuffer = '';
    cursorPos = 0;
    drawInputLine();
    if (line && onEnter) onEnter(line);
    return;
  }
  // BACKSPACE
  if (ch === '\x7f' || ch === '\b') {
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      drawInputLine();
    }
    return;
  }
  // Ctrl+U — clear line
  if (ch === '\x15') {
    inputBuffer = '';
    cursorPos = 0;
    drawInputLine();
    return;
  }
  // Printable
  if (ch >= ' ' && ch <= '~') {
    inputBuffer = inputBuffer.slice(0, cursorPos) + ch + inputBuffer.slice(cursorPos);
    cursorPos++;
    drawInputLine();
    return;
  }
  // Arrow keys (escape sequences) — skip for now
}

function rawDataHandler(chunk: string): void {
  for (const ch of chunk) handleChar(ch);
}

export function startInput(): void {
  if (inputActive) return;
  inputActive = true;
  inputBuffer = '';
  cursorPos = 0;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  stdinHandler = rawDataHandler;
  process.stdin.on('data', stdinHandler);
  drawInputLine();
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

export function initTui(): void {
  hideCursor();
  // Reserve space
  process.stdout.write('\n'.repeat(INPUT_LINES));
  cursorUp(INPUT_LINES);
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
  return '─'.repeat(Math.min(process.stdout.columns ?? 80, 60));
}

export function createTuiDisplay(): Display {
  let inStream = false;

  return {
    agentThinking() {},

    toolStart(_name: string, _id: string) {},

    streamText(text: string) {
      if (!inStream) {
        inStream = true;
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

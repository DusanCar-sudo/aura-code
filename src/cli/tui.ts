/**
 * TUI — Top-input layout: fixed input at the top, output scrolls below.
 *
 * ──────────────────────────────────
 *  ╭ ask aura ───────────────────╮   ← fixed at top
 *  ╰❯ your input here█          │
 * ──────────────────────────────────
 *  → output scrolls below ↓
 *  ✓ tool result
 *  ✓ done
 *  ...
 *
 * The user can type at any time. Ctrl+C aborts the current task.
 */
import chalk from 'chalk';
import type { Display } from './display.js';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';
import { formatContextBar, formatContextDashboard } from './context-health.js';

// ── State ──────────────────────────────────────────────────────────────────

let inputBuffer = '';
let cursorPos = 0;
let inputActive = false;
let stdinHandler: ((data: string) => void) | null = null;
let chatId = '';
let promptLines = 0; // how many lines the prompt actually takes (2)
let outputLine = 0;  // how many lines of output have been written

let onEnter: ((line: string) => void) | null = null;
let onStop: (() => void) | null = null;
let currentAbort: AbortController | null = null;

export function createAbortController(): AbortController {
  currentAbort = new AbortController();
  return currentAbort;
}
export function clearAbortController(): void { currentAbort = null; }

// ── Low-level ──────────────────────────────────────────────────────────────

function home(): void { process.stdout.write('\x1b[H'); }
function clearEol(): void { process.stdout.write('\x1b[0K'); }
function clearEos(): void { process.stdout.write('\x1b[0J'); }
function cursorUp(n: number): void { if (n > 0) process.stdout.write(`\x1b[${n}A`); }
function cursorDown(n: number): void { if (n > 0) process.stdout.write(`\x1b[${n}B`); }
function cursorCol(n: number): void { process.stdout.write(`\x1b[${n}G`); }
function scrollUp(n: number): void { process.stdout.write(`\x1b[${n}S`); }
function hideCursor(): void { process.stdout.write('\x1b[?25l'); }
function showCursor(): void { process.stdout.write('\x1b[?25h'); }

const cols = () => process.stdout.columns ?? 80;
const fieldWidth = () => Math.min(cols(), 100) - 4;

// ── Prompt rendering ───────────────────────────────────────────────────────

function drawPromptTop(): void {
  const w = fieldWidth();
  const idTag = chatId ? ` ${chatId}` : '';
  const label = ` ask aura${idTag} `;
  const dashes = Math.max(0, w - label.length - 1);
  const txt = inputBuffer;
  const cursorChar = chalk.hex('#cc785c')('█');

  // ── Line 1: go to row 0, clear only this line, draw border ──
  home();
  clearEol();
  process.stdout.write('  ' + chalk.hex('#9b1b30')('╭' + chalk.hex('#8a7768')(label) + '─'.repeat(dashes) + '╮'));

  // ── Line 2: go to row 1, clear only this line, draw prompt ──
  home();
  cursorDown(1);
  cursorCol(1);
  clearEol();
  const prompt = chalk.hex('#9b1b30')('╰ ') + chalk.hex('#cc785c').bold('❯ ');
  const placeholder = txt.length === 0
    ? chalk.hex('#4e3d30')('type a task, :btw, :q, :help...  ')
    : '';

  if (txt.length === 0) {
    process.stdout.write('  ' + prompt + placeholder + cursorChar);
  } else {
    const before = chalk.hex('#ede0cc')(txt.slice(0, cursorPos));
    const at = cursorChar;
    const after = chalk.hex('#ede0cc')(txt.slice(cursorPos));
    process.stdout.write('  ' + prompt + before + at + after);
  }

  promptLines = 2;

  // ── Move cursor to end of output area (row 2 + outputLine) ──
  const outputRow = 2 + outputLine;
  home();
  cursorDown(outputRow);
}

// ── Output ─────────────────────────────────────────────────────────────────

/** Write a line of output below the prompt. */
export function writeOutput(text: string): void {
  // Position at row 2 + outputLine (row 0-1 = prompt)
  const row = 2 + outputLine;
  home();
  cursorDown(row);
  cursorCol(1);
  clearEol();
  process.stdout.write(text);
  process.stdout.write('\n');
  outputLine++;

  // Check if we're near bottom of terminal — scroll output area up
  const termRows = process.stdout.rows ?? 24;
  if (2 + outputLine >= termRows - 1) {
    // Scroll the output area up by 1 line (preserving prompt at rows 0-1)
    scrollUp(1);
    // Redraw just the two prompt lines (don't erase output below)
    drawPromptTop();
  }

  // Position cursor at end of output
  home();
  cursorDown(2 + outputLine);
}

/** Streaming text — appends to current output line. */
export function writeStream(text: string): void {
  process.stdout.write(text);
}

// ── Input handling ─────────────────────────────────────────────────────────

function handleChar(ch: string): void {
  if (ch === '\x03') {
    if (currentAbort && !currentAbort.signal.aborted) {
      currentAbort.abort();
      writeOutput(chalk.hex('#d4903a')('  ⏹ Aborting current task...'));
      if (onStop) onStop();
      return;
    }
    showCursor();
    process.stdout.write('\n');
    process.exit(0);
  }

  if (ch === '\r' || ch === '\n') {
    const line = inputBuffer.trim();
    if (line) {
      // Echo the input to output area
      writeOutput(chalk.hex('#4e3d30')(`❯ ${line}`));
    }
    inputBuffer = '';
    cursorPos = 0;
    drawPromptTop();
    if (line && onEnter) onEnter(line);
    return;
  }

  if (ch === '\x7f' || ch === '\b') {
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      drawPromptTop();
    }
    return;
  }

  if (ch === '\x15') {
    inputBuffer = '';
    cursorPos = 0;
    drawPromptTop();
    return;
  }

  if (ch >= ' ' && ch <= '~') {
    inputBuffer = inputBuffer.slice(0, cursorPos) + ch + inputBuffer.slice(cursorPos);
    cursorPos++;
    drawPromptTop();
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
  // Don't clear the screen — banner from renderBanner() is already there.
  // outputLine starts at 0; first writeOutput() goes to row 2.
  outputLine = 0;
  hideCursor();
  drawPromptTop();
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
  return '─'.repeat(Math.min(cols(), 60));
}

export function createTuiDisplay(): Display {
  let inStream = false;
  let thinkingFrame = 0;

  return {
    agentThinking() {
      // Show a subtle spinner on its own line
      const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const s = spinners[(thinkingFrame++) % spinners.length];
      const row = 2 + outputLine;
      home();
      cursorDown(row);
      cursorCol(1);
      clearEol();
      process.stdout.write(chalk.hex('#8a7768')(`  ${s} thinking`));
      // Don't increment outputLine — this line will be overwritten
    },
    toolStart() {},

    streamText(text: string) {
      if (!inStream) {
        inStream = true;
        // Position at end of output area
        const row = 2 + outputLine;
        home();
        cursorDown(row);
        cursorCol(1);
        clearEol();
      }
      writeStream(chalk.hex('#ede0cc')(text));
    },

    streamEnd() {
      if (inStream) {
        process.stdout.write('\n');
        outputLine++;
        inStream = false;
        // Position cursor to end of output
        home();
        cursorDown(2 + outputLine);
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

    contextBar(health) {
      writeOutput(formatContextBar(health));
    },

    contextDashboard(health) {
      writeOutput(formatContextDashboard(health));
    },

    compactionEvent(info) {
      const saved = ((1 - info.afterTokens / info.beforeTokens) * 100).toFixed(0);
      writeOutput(chalk.hex('#d4903a')(`  ⚠  Context compacted: ${info.beforeTokens.toLocaleString()} → ${info.afterTokens.toLocaleString()} tokens (-${saved}%) · gen ${info.generation}`));
    },
  };
}

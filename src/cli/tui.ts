/**
 * TUI v2 — Bottom-input layout: output scrolls at the top, input box
 * pinned at the bottom. Inspired by OpenCode and Hermes Agent.
 *
 * Layout (using DECSTBM scroll region to protect bottom rows):
 *  ┌─────────────────────────────────────────────┐
 *  │  [banner]                                     │  ← scroll region (top)
 *  │  [output scrollback — scrolls here]           │
 *  │  ────────────────────────────────────────    │
 *  │  │ user message                    6:42 PM   │
 *  │  │ ◆ thinking…                                │
 *  │  │ ✓ done                                     │
 *  ╞═════════════════════════════════════════════╡  ← scroll region boundary
 *  │  -- INSERT -- glm-5.2 · opencode-go           │  ← fixed bottom (outside scroll)
 *  │  ╭ ask aura ──────────────────────────────╮  │
 *  │  │ your input here█                        │  │
 *  │  ╰────────────────────────────────────────╯  │
 *  │  ◆ Context: ████░░░░ 40% · 2.1k/128k · $0.03 │
 *  └─────────────────────────────────────────────┘
 *
 * Key bindings:
 *  Ctrl+P  — Command palette
 *  Ctrl+L  — Session switcher
 *  Tab     — Agent switcher (build/plan)
 *  Esc     — Scroll mode (vim pager)
 *  Ctrl+C  — Abort task or exit
 */
import chalk from 'chalk';
import type { Display } from './display.js';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';
import { formatContextBar, formatContextDashboard } from './context-health.js';
import { gradient, gradientStopFor, TEXT_HEX, TEXT_DIM_HEX, BG_HEX, CHROME_DIM, RUBY_ACCENT } from './diamond.js';
import { PALETTE_COMMANDS, filterCommands, renderPalette, type PaletteCommand } from './command-palette.js';
import { renderMarkdown } from './markdown.js';

const TEXT = chalk.hex(TEXT_HEX);
const TEXT_DIM = chalk.hex(TEXT_DIM_HEX);
const ACCENT = chalk.hex('#cc785c');
const RUBY = RUBY_ACCENT;

// ── State ──────────────────────────────────────────────────────────────────

let inputBuffer = '';
let cursorPos = 0;
let inputActive = false;
export { inputActive };
let stdinHandler: ((data: string) => void) | null = null;
let chatId = '';

// ── Agent mode (Tab switcher) ──────────────────────────────────────────────

export type AgentMode = 'build' | 'plan';
let agentMode: AgentMode = 'build';
let onModeChange: ((mode: AgentMode) => void) | null = null;
export function setAgentMode(mode: AgentMode): void { agentMode = mode; if (onModeChange) onModeChange(mode); }
export function getAgentMode(): AgentMode { return agentMode; }
export function setModeChangeHandler(fn: (mode: AgentMode) => void): void { onModeChange = fn; }

// ── Overlay state (command palette, etc.) ──────────────────────────────────

type OverlayType = 'none' | 'palette' | 'session';
let overlay: OverlayType = 'none';
let overlayQuery = '';
let overlaySelected = 0;

function openOverlay(type: OverlayType): void {
  overlay = type;
  overlayQuery = '';
  overlaySelected = 0;
  drawPromptBottom();
}

function closeOverlay(): void {
  overlay = 'none';
  overlayQuery = '';
  overlaySelected = 0;
  drawPromptBottom();
}

// ── Scroll mode ────────────────────────────────────────────────────────────

let scrollMode = false;
let scrollOffset = 0;
let pendingG = false;
let scrollBuffer: string[] = [];
const MAX_SCROLLBACK = 5000;
let streamAccum = '';
let bannerLines: string[] = [];

// ── Live tool spinner ──────────────────────────────────────────────────────

interface ActiveTool {
  name: string;
  startTime: number;
  spinnerFrame: number;
  intervalHandle: ReturnType<typeof setInterval> | null;
}
let activeTool: ActiveTool | null = null;

function startToolSpinner(name: string): void {
  stopToolSpinner();
  activeTool = { name, startTime: Date.now(), spinnerFrame: 0, intervalHandle: null };
  if (!scrollMode) {
    activeTool.intervalHandle = setInterval(() => {
      if (!activeTool || scrollMode) return;
      activeTool.spinnerFrame++;
      const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const s = spinners[activeTool.spinnerFrame % spinners.length];
      const elapsed = ((Date.now() - activeTool.startTime) / 1000).toFixed(1);
      // Write spinner on the last output line (inside scroll region)
      cursorCol(1);
      clearEol();
      rawWrite(ACCENT(`  ${s} ${activeTool.name}`) + TEXT_DIM(`  ${elapsed}s`));
      cursorCol(1);
    }, 100);
  }
}

function stopToolSpinner(): void {
  if (activeTool?.intervalHandle) {
    clearInterval(activeTool.intervalHandle);
    activeTool.intervalHandle = null;
  }
  if (activeTool && !scrollMode) {
    cursorCol(1);
    clearEol();
  }
  activeTool = null;
}

// ── Footer ──────────────────────────────────────────────────────────────────

let footerActive = false;
let footerText = '';

export function setFooter(text: string): void {
  footerText = text;
  footerActive = true;
  if (inputActive) drawPromptBottom();
}

let panelSuggestions: string[] = [];

export function setPanelContent(opts: { suggestions?: string[] }): void {
  if (opts.suggestions) panelSuggestions = opts.suggestions;
  if (inputActive) drawPromptBottom();
}

let statusLineText = '';
export function setStatusLine(text: string): void {
  statusLineText = text;
  if (inputActive) drawPromptBottom();
}

export function createAbortController(): AbortController {
  currentAbort = new AbortController();
  return currentAbort;
}
export function clearAbortController(): void { currentAbort = null; }

// ── Session switcher callback ───────────────────────────────────────────────

let onSessionSwitch: (() => void) | null = null;
export function setSessionSwitchHandler(fn: () => void): void { onSessionSwitch = fn; }

// ── Low-level ──────────────────────────────────────────────────────────────

let realStdoutWrite: typeof process.stdout.write | null = null;

function rawWrite(s: string): void {
  (realStdoutWrite ?? process.stdout.write.bind(process.stdout))(s);
}

function clearEol(): void { rawWrite('\x1b[0K'); }
function cursorUp(n: number): void { if (n > 0) rawWrite(`\x1b[${n}A`); }
function cursorDown(n: number): void { if (n > 0) rawWrite(`\x1b[${n}B`); }
function cursorCol(n: number): void { rawWrite(`\x1b[${n}G`); }
function hideCursor(): void { rawWrite('\x1b[?25l'); }
function showCursor(): void { rawWrite('\x1b[?25h'); }

let altScreenActive = false;
export function enterAltScreen(): void {
  altScreenActive = true;
  rawWrite('\x1b[?1049h');
  // OSC 11: set the terminal's default background to the palette's bluish
  // dark. Restored via OSC 111 on leave — no per-line bg painting needed.
  rawWrite(`\x1b]11;${BG_HEX}\x07`);
}
export function leaveAltScreen(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  rawWrite('\x1b]111\x07'); // OSC 111: reset background to terminal default
  rawWrite('\x1b[?1049l');
}

const cols = () => process.stdout.columns ?? 80;
const screenRows = () => process.stdout.rows ?? 24;

function handleExternalWrite(chunk: string): void {
  if (!inputActive) { rawWrite(chunk); return; }
  if (chunk.endsWith('\n')) {
    writeOutput(chunk.slice(0, -1));
  } else if (scrollMode) {
    streamAccum += chunk;
  } else {
    rawWrite(chunk);
  }
}

function patchStdout(): void {
  if (realStdoutWrite) return;
  realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    handleExternalWrite(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

function unpatchStdout(): void {
  if (realStdoutWrite) {
    process.stdout.write = realStdoutWrite;
    realStdoutWrite = null;
  }
}

process.on('exit', () => {
  try {
    rawWrite('\x1b[r');        // reset scroll region
    leaveAltScreen();
    unpatchStdout();
  } catch { /* best effort */ }
});

// ── Bottom-input layout via DECSTBM ─────────────────────────────────────────
//
// The screen is split into two regions using DECSTBM (scroll region):
//   Rows 1..(sr-FIXED_BOTTOM) — scrollable output region
//   Rows (sr-FIXED_BOTTOM+1)..sr — fixed bottom block (input box etc.)
//
// DECSTBM sets the region inside which scrolling/line-feed happens.
// The cursor jumps to the region's home when set — we account for that.
// The bottom block is redrawn in place whenever the input changes, by
// positioning the cursor to the bottom rows directly.

const BOX_CONTENT_ROWS = 3;
const HEADER_ROWS = 5; // top border + content + bottom border
const STATUS_ROW = 1;
const FOOTER_ROW = 1;
const FIXED_BOTTOM = HEADER_ROWS + STATUS_ROW + FOOTER_ROW; // 7

const LEAD = 2;
const MARGIN = 1;

function computeLayout(): { boxWidth: number } {
  const total = cols();
  return { boxWidth: Math.min(total - LEAD - MARGIN, 100) };
}

function wrapInput(innerWidth: number): { rows: string[]; cursorRow: number; cursorCol: number } {
  const w = Math.max(4, innerWidth);
  const chunks: string[] = [];
  for (let i = 0; i < inputBuffer.length || i === 0; i += w) {
    chunks.push(inputBuffer.slice(i, i + w));
    if (inputBuffer.length === 0) break;
  }
  let cursorChunk = Math.floor(cursorPos / w);
  let cursorColIdx = cursorPos % w;
  let visible = chunks;
  if (chunks.length > BOX_CONTENT_ROWS) {
    const hidden = chunks.length - BOX_CONTENT_ROWS;
    visible = chunks.slice(hidden);
    cursorChunk -= hidden;
  }
  if (cursorChunk < 0) { cursorChunk = 0; cursorColIdx = 0; }
  while (visible.length < BOX_CONTENT_ROWS) visible.push('');
  return { rows: visible, cursorRow: cursorChunk, cursorCol: cursorColIdx };
}

function padVisible(s: string, width: number): string {
  const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return s + ' '.repeat(Math.max(0, width - visibleLen));
}

function truncVisible(s: string, width: number): string {
  const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  if (visibleLen <= width) return s;
  let i = 0, visCount = 0, out = '';
  while (i < s.length && visCount < Math.max(0, width - 1)) {
    const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += s[i]; visCount++; i++;
  }
  return out + '\x1b[0m…';
}

/**
 * Build the bottom block lines: status line, input box, footer.
 * Returns lines in top-to-bottom order.
 */
function buildBottomRows(): string[] {
  const { boxWidth } = computeLayout();
  const idTag = chatId ? ` ${chatId}` : '';
  const label = ` ask aura${idTag} `;
  const innerWidth = boxWidth - 4;
  const wrapped = wrapInput(innerWidth);
  const focused = !scrollMode;
  const modeTag = focused ? ACCENT.bold('-- INSERT --') : ACCENT.bold('-- SCROLL --');
  const agentTag = agentMode === 'plan' ? ACCENT(' [plan]') : '';
  const cursorChar = focused ? ACCENT('█') : '';
  const rows: string[] = [];

  // Status line
  rows.push(' '.repeat(LEAD) + padVisible(modeTag + agentTag + TEXT_DIM(` ${statusLineText}`), boxWidth));

  // Input box
  for (let row = 0; row < HEADER_ROWS; row++) {
    let boxPart: string;
    if (row === 0) {
      const dashes = Math.max(0, boxWidth - label.length - 2);
      boxPart = focused
        ? gradient('╭') + TEXT_DIM(label) + gradient('─'.repeat(dashes)) + gradient('╮')
        : CHROME_DIM('╭' + label + '─'.repeat(dashes) + '╮');
    } else if (row === HEADER_ROWS - 1) {
      boxPart = focused
        ? gradient('╰' + '─'.repeat(boxWidth - 2) + '╯')
        : CHROME_DIM('╰' + '─'.repeat(boxWidth - 2) + '╯');
    } else {
      const contentRow = row - 1;
      const text = wrapped.rows[contentRow] ?? '';
      const isCursorRow = contentRow === wrapped.cursorRow;
      const showPlaceholder = inputBuffer.length === 0 && contentRow === 0;
      let inner: string;
      if (showPlaceholder) {
        inner = TEXT_DIM('type a task, :btw, :q, :help...') + cursorChar;
        inner = padVisible(inner, innerWidth);
      } else if (isCursorRow && focused) {
        const before = TEXT(text.slice(0, wrapped.cursorCol));
        const after = TEXT(text.slice(wrapped.cursorCol));
        inner = padVisible(before + cursorChar + after, innerWidth);
      } else {
        inner = padVisible((focused ? TEXT : TEXT_DIM)(text), innerWidth);
      }
      const border = focused ? gradientStopFor(row, HEADER_ROWS)('│') : CHROME_DIM('│');
      boxPart = border + ' ' + inner + ' ' + border;
    }
    rows.push(' '.repeat(LEAD) + boxPart);
  }

  return rows;
}

/**
 * Set the terminal scroll region to exclude the bottom FIXED_BOTTOM rows.
 * After DECSTBM, the cursor moves to the home position of the region.
 */
function setScrollRegion(): void {
  const sr = screenRows();
  const scrollEnd = sr - FIXED_BOTTOM;
  if (scrollEnd < 1) return;
  // DECSTBM: \x1b[top;bottom;r — set scroll region from row `top` to `bottom`
  rawWrite(`\x1b[1;${scrollEnd}r`);
  // Move cursor to top of scroll region (DECSTBM homes cursor there)
  rawWrite(`\x1b[1;1H`);
}

/**
 * Reset scroll region to full screen.
 */
function resetScrollRegion(): void {
  rawWrite('\x1b[r');
}

/**
 * Draw the bottom block (status + input box + footer) at the bottom of the screen.
 * Uses absolute row positioning to the fixed bottom rows — these are OUTSIDE
 * the scroll region, so they're never scrolled away.
 */
function drawPromptBottom(): void {
  if (scrollMode || fullscreenPrompt) return;
  const rows = buildBottomRows();
  const sr = screenRows();
  // The bottom block starts at row (sr - FIXED_BOTTOM + 1)
  const startRow = sr - FIXED_BOTTOM + 1;

  for (let i = 0; i < rows.length; i++) {
    const row = startRow + i;
    rawWrite(`\x1b[${row};1H`);
    clearEol();
    rawWrite(rows[i]);
  }

  // Footer on the very last row
  if (footerActive) {
    rawWrite(`\x1b[${sr};1H`);
    clearEol();
    rawWrite(truncVisible(footerText, Math.max(10, cols() - MARGIN)));
  }

  // Return cursor to the scroll region (where output goes)
  // Position at the bottom of the scroll region
  const scrollEnd = sr - FIXED_BOTTOM;
  rawWrite(`\x1b[${scrollEnd};1H`);
}

// ── Fullscreen mode for interactive prompts (wizard etc.) ──────────────────
//
// When an interactive prompt like the provider wizard needs many rows,
// collapse the bottom block and expand the scroll region to the full screen.
// The wizard's own readline handles input; the TUI's input box is hidden.
let fullscreenPrompt = false;

export function enterFullscreenPrompt(): void {
  fullscreenPrompt = true;
  resetScrollRegion();
  // Clear the bottom block area
  const sr = screenRows();
  for (let r = sr - FIXED_BOTTOM + 1; r <= sr; r++) {
    rawWrite(`\x1b[${r};1H`);
    clearEol();
  }
  // Move cursor to where output was
  rawWrite(`\x1b[${sr - FIXED_BOTTOM};1H`);
}

export function exitFullscreenPrompt(): void {
  fullscreenPrompt = false;
  setScrollRegion();
  drawPromptBottom();
}

// ── Output ─────────────────────────────────────────────────────────────────

function wrapForTerminal(text: string): { output: string; lineCount: number } {
  const maxWidth = Math.max(10, cols() - MARGIN);
  const physicalLines: string[] = [];
  for (const line of text.split('\n')) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (visible.length <= maxWidth) { physicalLines.push(line); continue; }
    let i = 0, visCount = 0, chunk = '';
    while (i < line.length) {
      const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { chunk += m[0]; i += m[0].length; continue; }
      if (visCount >= maxWidth) { physicalLines.push(chunk); chunk = ''; visCount = 0; continue; }
      chunk += line[i]; visCount++; i++;
    }
    physicalLines.push(chunk);
  }
  return { output: physicalLines.join('\n'), lineCount: physicalLines.length };
}

export function writeOutput(text: string): void {
  if (streamAccum) {
    pushScrollback(wrapForTerminal(streamAccum).output.split('\n'));
    streamAccum = '';
  }
  const { output, lineCount } = wrapForTerminal(text);
  pushScrollback(output.split('\n'));
  if (scrollMode) {
    scrollOffset = Math.min(scrollOffset + lineCount, maxScrollOffset());
    renderScrollView();
    return;
  }
  if (fullscreenPrompt) {
    // Fullscreen mode: just write naturally, no scroll region, no bottom block
    rawWrite(output + '\n');
    return;
  }
  // Write inside the scroll region — output scrolls naturally above the bottom block
  cursorCol(1);
  clearEol();
  rawWrite(output);
  rawWrite('\n');
}

export function writeStream(text: string): void {
  streamAccum += text;
  if (scrollMode) return;
  rawWrite(text);
}

function echoUserLine(line: string): void {
  const bar = RUBY('│ ');
  writeOutput(bar + TEXT(line));
  writeOutput(bar + TEXT_DIM(formatTime(new Date())));
}

function formatTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function pushScrollback(lines: string[]): void {
  for (const line of lines) scrollBuffer.push(line);
  if (scrollBuffer.length > MAX_SCROLLBACK) {
    scrollBuffer.splice(0, scrollBuffer.length - MAX_SCROLLBACK);
  }
}

export function setBannerLines(lines: string[]): void {
  bannerLines = lines;
}

// ── Scroll-mode rendering ──────────────────────────────────────────────────

function viewHeight(): number {
  return Math.max(3, screenRows() - FIXED_BOTTOM - 1);
}

function maxScrollOffset(): number {
  return Math.max(0, scrollBuffer.length - viewHeight());
}

function renderScrollView(): void {
  const bottomRows = buildBottomRows();
  const vh = viewHeight();
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxScrollOffset()));
  const start = Math.max(0, scrollBuffer.length - vh - scrollOffset);
  const visible = scrollBuffer.slice(start, start + vh);
  const width = Math.max(10, cols() - MARGIN);
  const sr = screenRows();

  rawWrite('\x1b[2J\x1b[H');
  // Banner
  const withBanner = bannerLines.length > 0 && sr - bannerLines.length - FIXED_BOTTOM - 1 >= 3;
  if (withBanner) {
    bannerLines.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });
  }
  visible.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });
  for (let i = visible.length; i < vh; i++) rawWrite('\n');

  // Bottom block
  const startRow = sr - FIXED_BOTTOM + 1;
  for (let i = 0; i < bottomRows.length; i++) {
    rawWrite(`\x1b[${startRow + i};1H`);
    rawWrite(bottomRows[i]);
  }

  const bottom = start + visible.length;
  const pos = scrollOffset === 0 ? 'BOT' : start === 0 ? 'TOP' : `${Math.round((bottom / Math.max(1, scrollBuffer.length)) * 100)}%`;
  const indicator = ACCENT.bold(' -- SCROLL -- ')
    + TEXT_DIM(`${start + 1}-${bottom}/${scrollBuffer.length} ${pos} · j/k · ^d/^u · gg/G · i/Enter/Esc insert`);
  rawWrite(`\x1b[${sr};1H`);
  rawWrite(truncVisible(indicator, width));
}

function enterScrollMode(initialOffset: number): void {
  if (scrollBuffer.length === 0) return;
  scrollMode = true;
  pendingG = false;
  scrollOffset = initialOffset;
  renderScrollView();
}

function exitScrollMode(): void {
  scrollMode = false;
  pendingG = false;
  scrollOffset = 0;
  redrawLiveView();
}

function redrawLiveView(): void {
  const width = Math.max(10, cols() - MARGIN);
  const sr = screenRows();

  rawWrite('\x1b[2J\x1b[H');
  // Banner
  const withBanner = bannerLines.length > 0 && sr - bannerLines.length - FIXED_BOTTOM - 1 >= 3;
  const banner = withBanner ? bannerLines : [];
  banner.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });

  // Output tail
  const tailMax = Math.max(0, sr - banner.length - FIXED_BOTTOM);
  const tail = scrollBuffer.slice(Math.max(0, scrollBuffer.length - tailMax));
  tail.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });

  // Bottom block
  const bottomRows = buildBottomRows();
  const startRow = sr - FIXED_BOTTOM + 1;
  for (let i = 0; i < bottomRows.length; i++) {
    rawWrite(`\x1b[${startRow + i};1H`);
    clearEol();
    rawWrite(bottomRows[i]);
  }

  // Footer
  if (footerActive) {
    rawWrite(`\x1b[${sr};1H`);
    clearEol();
    rawWrite(truncVisible(footerText, Math.max(10, cols() - MARGIN)));
  }
}

// ── Confirm / Input ─────────────────────────────────────────────────────────

let pendingConfirm: ((answer: string) => void) | null = null;
let pendingInput: ((text: string) => void) | null = null;
let inputAccumulator: string[] = [];

export function askConfirm(message: string): Promise<boolean> {
  return new Promise(resolve => {
    writeOutput(chalk.hex('#d4903a')(`  ⚠  ${message} [y/N]`));
    pendingConfirm = (answer: string) => {
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    };
  });
}

export function askInput(prompt: string): Promise<string> {
  return new Promise(resolve => {
    if (fullscreenPrompt) {
      // In fullscreen mode, write prompt directly and use raw readline-style input
      rawWrite(chalk.hex('#cc785c')(prompt));
      pendingInput = (text: string) => {
        rawWrite(text + '\n');
        resolve(text);
      };
      inputAccumulator = [];
      inputBuffer = '';
      cursorPos = 0;
      return;
    }
    writeOutput(chalk.hex('#cc785c')(prompt));
    pendingInput = (text: string) => { resolve(text); };
    inputAccumulator = [];
  });
}

// ── Input handling ─────────────────────────────────────────────────────────

function handleChar(ch: string): void {
  if (ch === '\x03') { // Ctrl-C
    if (overlay !== 'none') { closeOverlay(); return; }
    if (pendingConfirm) {
      const resolve = pendingConfirm;
      pendingConfirm = null;
      inputBuffer = '';
      cursorPos = 0;
      writeOutput(TEXT_DIM('❯ n (cancelled)'));
      resolve('n');
      return;
    }
    if (pendingInput) {
      const resolve = pendingInput;
      pendingInput = null;
      inputAccumulator = [];
      inputBuffer = '';
      cursorPos = 0;
      writeOutput(TEXT_DIM('❯ (cancelled)'));
      drawPromptBottom();
      resolve('');
      return;
    }
    if (currentAbort && !currentAbort.signal.aborted) {
      currentAbort.abort();
      writeOutput(chalk.hex('#d4903a')('  ⏹ Aborting current task...'));
      if (onStop) onStop();
      return;
    }
    resetScrollRegion();
    unpatchStdout();
    leaveAltScreen();
    showCursor();
    process.exit(0);
  }

  if (ch === '\x04') { // Ctrl-D
    if (pendingInput) {
      const resolve = pendingInput;
      pendingInput = null;
      const finalText = inputAccumulator.join('\n');
      inputAccumulator = [];
      inputBuffer = '';
      cursorPos = 0;
      writeOutput(TEXT_DIM('❯ (end of input)'));
      drawPromptBottom();
      resolve(finalText);
      return;
    }
  }

  if (ch === '\r' || ch === '\n') {
    // Overlay Enter
    if (overlay === 'palette') {
      const commands = filterCommands(overlayQuery);
      if (commands[overlaySelected]) {
        const cmd = commands[overlaySelected];
        closeOverlay();
        if (onEnter) onEnter(cmd.id);
      }
      return;
    }
    if (overlay === 'session') { closeOverlay(); if (onSessionSwitch) onSessionSwitch(); return; }

    const line = inputBuffer.trim();

    if (pendingConfirm) {
      const resolve = pendingConfirm;
      pendingConfirm = null;
      writeOutput(TEXT_DIM(`❯ ${line || 'n'}`));
      inputBuffer = '';
      cursorPos = 0;
      drawPromptBottom();
      resolve(line);
      return;
    }

    if (pendingInput) {
      if (fullscreenPrompt) {
        // Fullscreen mode: single-line submit on Enter
        const resolve = pendingInput;
        pendingInput = null;
        const line = inputBuffer;
        if (line) rawWrite(line + '\n');
        inputBuffer = '';
        cursorPos = 0;
        resolve(line);
        return;
      }
      // Normal TUI mode: accumulate lines, Ctrl-D submits
      inputAccumulator.push(inputBuffer);
      inputBuffer = '';
      cursorPos = 0;
      drawPromptBottom();
      return;
    }

    if (line) {
      echoUserLine(line);
    }
    inputBuffer = '';
    cursorPos = 0;
    drawPromptBottom();
    if (line && onEnter) onEnter(line);
    return;
  }

  if (ch === '\x7f' || ch === '\b') {
    if (overlay !== 'none') {
      if (overlayQuery.length > 0) {
        overlayQuery = overlayQuery.slice(0, -1);
        overlaySelected = 0;
        drawPromptBottom();
      }
      return;
    }
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      if (fullscreenPrompt && pendingInput) {
        rawWrite('\b \b');
      }
      drawPromptBottom();
    }
    return;
  }

  if (ch === '\x15') { // Ctrl-U
    if (overlay !== 'none') { overlayQuery = ''; overlaySelected = 0; drawPromptBottom(); return; }
    inputBuffer = '';
    cursorPos = 0;
    drawPromptBottom();
    return;
  }

  if (ch === '\t') { // Tab — agent mode switcher
    agentMode = agentMode === 'build' ? 'plan' : 'build';
    if (onModeChange) onModeChange(agentMode);
    drawPromptBottom();
    return;
  }

  if (ch >= ' ' && ch <= '~') {
    if (overlay !== 'none') {
      overlayQuery += ch;
      overlaySelected = 0;
      drawPromptBottom();
      return;
    }
    inputBuffer = inputBuffer.slice(0, cursorPos) + ch + inputBuffer.slice(cursorPos);
    cursorPos++;
    if (fullscreenPrompt && pendingInput) {
      // Echo typed char directly in fullscreen mode
      rawWrite(ch);
    }
    drawPromptBottom();
    return;
  }
}

function handleScrollKey(key: string): void {
  const half = Math.floor(viewHeight() / 2);
  const gWasPending = pendingG;
  pendingG = false;
  switch (key) {
    case 'g':
      if (!gWasPending) { pendingG = true; return; }
      scrollOffset = maxScrollOffset();
      break;
    case 'k': case '\x1b[A': scrollOffset += 1; break;
    case 'j': case '\x1b[B': scrollOffset -= 1; break;
    case '\x15': case '\x1b[5~': scrollOffset += half; break;
    case '\x04': case '\x1b[6~': scrollOffset -= half; break;
    case 'G': scrollOffset = 0; break;
    case 'i': case 'q': case '\x1b': case '\r': case '\n': case '\x03':
      exitScrollMode();
      return;
    default: return;
  }
  renderScrollView();
}

function handleKey(key: string): void {
  if (scrollMode) { handleScrollKey(key); return; }

  // Ctrl+P — command palette (0x10)
  if (key === '\x10') { openOverlay('palette'); return; }
  // Ctrl+L — session switcher (0x0c)
  if (key === '\x0c') { openOverlay('session'); return; }

  if (key === '\x1b') {
    if (overlay !== 'none') { closeOverlay(); return; }
    enterScrollMode(0);
    return;
  }
  if (key === '\x1b[A' && inputBuffer.length === 0) {
    enterScrollMode(1);
    return;
  }
  if (key === '\x1b[5~') {
    enterScrollMode(Math.floor(viewHeight() / 2));
    return;
  }
  if (key === '\x1b[D') {
    if (overlay !== 'none') return;
    if (cursorPos > 0) { cursorPos--; drawPromptBottom(); }
    return;
  }
  if (key === '\x1b[C') {
    if (overlay !== 'none') return;
    if (cursorPos < inputBuffer.length) { cursorPos++; drawPromptBottom(); }
    return;
  }
  // Arrow up/down in overlay
  if (overlay !== 'none') {
    if (key === '\x1b[A') { overlaySelected = Math.max(0, overlaySelected - 1); drawPromptBottom(); return; }
    if (key === '\x1b[B') {
      const commands = filterCommands(overlayQuery);
      overlaySelected = Math.min(commands.length - 1, overlaySelected + 1);
      drawPromptBottom();
      return;
    }
  }
  if (key.length > 1) return;
  handleChar(key);
}

function rawHandler(data: string): void {
  let i = 0;
  while (i < data.length) {
    if (data[i] === '\x1b' && data[i + 1] === '[') {
      const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(data.slice(i));
      if (m) { handleKey(m[0]); i += m[0].length; continue; }
    }
    handleKey(data[i]);
    i++;
  }
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

let onEnter: ((line: string) => void) | null = null;
let onStop: (() => void) | null = null;
let currentAbort: AbortController | null = null;

export function setCallbacks(opts: { onEnter: (line: string) => void; onStop?: () => void }): void {
  onEnter = opts.onEnter;
  onStop = opts.onStop ?? null;
}

export function setChatId(id: string): void {
  chatId = id;
}

export function initTui(): void {
  scrollMode = false;
  scrollOffset = 0;
  pendingG = false;
  scrollBuffer = [];
  streamAccum = '';
  hideCursor();
  patchStdout();

  // Clear screen, draw banner
  rawWrite('\x1b[2J\x1b[H');
  const width = Math.max(10, cols() - MARGIN);
  if (bannerLines.length > 0) {
    bannerLines.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });
  }

  // Set scroll region to exclude bottom FIXED_BOTTOM rows
  setScrollRegion();

  // Draw the bottom block
  drawPromptBottom();

  // Divider in the scroll region
  writeOutput(gradient('─'.repeat(Math.min(cols(), 100))));
}

export function destroyTui(): void {
  stopToolSpinner();
  scrollMode = false;
  stopInput();
  resetScrollRegion();
  unpatchStdout();
  leaveAltScreen();
  showCursor();
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
  return gradient('─'.repeat(Math.min(cols(), 60)));
}

export function createTuiDisplay(): Display {
  let inStream = false;
  let thinkingFrame = 0;
  let thinkingInterval: ReturnType<typeof setInterval> | null = null;

  return {
    agentThinking() {
      if (scrollMode) return;
      if (thinkingInterval) clearInterval(thinkingInterval);
      const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      thinkingInterval = setInterval(() => {
        if (scrollMode) { if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; } return; }
        const s = spinners[(thinkingFrame++) % spinners.length];
        cursorCol(1);
        clearEol();
        rawWrite(TEXT_DIM(`  ${s} thinking`));
        cursorCol(1);
      }, 100);
    },

    stopThinking() {
      if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
      if (!scrollMode) { cursorCol(1); clearEol(); }
    },

    toolStart(name: string) {
      if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
      stopToolSpinner();
      startToolSpinner(name);
    },

    streamText(text: string) {
      if (!inStream) {
        inStream = true;
        stopToolSpinner();
        if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
        if (!scrollMode) {
          cursorCol(1);
          clearEol();
        }
      }
      writeStream(TEXT(text));
    },

    streamEnd() {
      if (inStream) {
        if (streamAccum) {
          pushScrollback(wrapForTerminal(streamAccum).output.split('\n'));
          streamAccum = '';
        }
        inStream = false;
        if (scrollMode) return;
        rawWrite('\n');
      }
    },

    toolCall(name: string, input: Record<string, unknown>) {
      stopToolSpinner();
      const icon = toolIcon(name);
      const label = chalk.hex('#cc785c').bold(`${icon} ${name}`);
      const detail = fmtIn(name, input);
      writeOutput(`  ${label}  ${TEXT_DIM(detail)}`);
    },

    toolResult(name: string, result: string, elapsedMs: number) {
      stopToolSpinner();
      const lines = result.split('\n');
      const preview = lines.length > 8
        ? lines.slice(0, 8).join('\n') + TEXT_DIM(`\n  ... (${lines.length - 8} more lines)`)
        : result;
      const elapsed = TEXT_DIM(`${elapsedMs}ms`);
      const isError = result.startsWith('Error:') || result.startsWith('Tool error');
      if (isError) {
        writeOutput('  ' + chalk.hex('#b15439')('✗ ') + TEXT_DIM(preview.replace(/\n/g, '\n    ')));
      } else {
        const fl = lines[0] ?? '';
        if (lines.length <= 3) {
          writeOutput('  ' + chalk.hex('#5a9e6e')('✓ ') + TEXT_DIM(result));
        } else {
          writeOutput('  ' + chalk.hex('#5a9e6e')('✓ ') + TEXT_DIM(`${fl}`) + TEXT_DIM(` (+${lines.length - 1} lines) ${elapsed}`));
        }
      }
    },

    toolBlocked(name: string, reason: string) {
      stopToolSpinner();
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
      writeOutput('\n' + l);
      writeOutput(chalk.hex('#cc785c').bold(`  ${title}`));
      if (subtitle) writeOutput(TEXT_DIM(`  ${subtitle}`));
      writeOutput(l);
    },

    summary(text: string, turns: number, toolCount: number) {
      const l = sep();
      writeOutput('\n' + l);
      writeOutput(chalk.hex('#5a9e6e').bold('  ✓ Done'));
      writeOutput(TEXT_DIM(`  ${turns} turn${turns > 1 ? 's' : ''} · ${toolCount} tool call${toolCount > 1 ? 's' : ''}`));
      if (text) {
        const mdLines = renderMarkdown(text);
        writeOutput('');
        mdLines.forEach(lx => writeOutput(lx));
      }
      writeOutput(l + '\n');
    },

    showPlan(plan: ExecutionPlan) {
      const l = sep();
      const idxMap = new Map<string, number>(plan.steps.map((s, i) => [s.id, i + 1]));
      writeOutput('\n' + l);
      writeOutput(chalk.hex('#cc785c').bold('  Execution Plan'));
      writeOutput(TEXT_DIM(`  Goal: ${plan.goal}`));
      writeOutput(l);
      plan.steps.forEach((s, i) => {
        const num  = TEXT_DIM(`${i + 1}.`);
        const spec = chalk.hex('#cc785c').bold(`[${s.specialist}]`);
        const task = TEXT(s.task.length > 55 ? s.task.slice(0, 52) + '…' : s.task);
        const deps = s.dependsOn.length > 0
          ? TEXT_DIM(` ← ${s.dependsOn.map(d => idxMap.get(d) ?? '?').join(', ')}`)
          : '';
        writeOutput(`  ${num} ${spec} ${task}${deps}`);
      });
      writeOutput(l + '\n');
    },

    stepStarted(step: PlanStep) {
      const spec = chalk.hex('#d4903a').bold(`[${step.specialist}]`);
      const task = TEXT_DIM(step.task.length > 70 ? step.task.slice(0, 67) + '…' : step.task);
      writeOutput('\n' + chalk.hex('#d4903a')('  →') + ` ${spec} ${task}`);
    },

    stepCompleted(step: PlanStep, _result: string) {
      const spec = chalk.hex('#5a9e6e').bold(`[${step.specialist}]`);
      const ms   = step.durationMs != null ? `${step.durationMs}ms` : '?ms';
      writeOutput(chalk.hex('#5a9e6e')('  ✓') + ` ${spec} ${TEXT_DIM(`done (${ms})`)}`);
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
      setFooter(formatContextBar(health));
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

/**
 * TUI — Top-input layout: fixed input at the top, output scrolls below.
 * Structural conventions borrowed from OpenCode's TUI (bubble-style message
 * echoes, a thin/subtle input-box border, an unboxed metadata line under
 * the box, a sidebar that outlasts the box in height) — but keeping Aura's
 * own ruby-gradient + gold-text identity rather than OpenCode's monochrome
 * palette.
 *
 * ──────────────────────────────────────────────────────────
 *  ╭ ask aura ──────────────╮      Try
 *  │ your input here█       │      · :help — see all commands
 *  │                        │      · run: npm test
 *  │                        │
 *  │                        │
 *  │                        │
 *  ╰────────────────────────╯
 *  -- INSERT -- gpt-4o · normal
 * ──────────────────────────────────────────────────────────
 *  │ give me the weather in Da Nang  (message bubble, ruby bar)
 *  │ 6:42 PM
 *  ✓ tool result
 *  ✓ done
 *  ...
 *
 * The header is two columns: the fixed-height multi-line input box (+ one
 * unboxed metadata row below it) and a right-side "Try" suggestions panel
 * whose height is independent of the box's. (The panel used to also carry
 * Commands/Skills sections — removed by design; the command list lives in
 * :help.) On narrow terminals the panel drops out and the box alone
 * widens — see computeLayout().
 *
 * Pinning strategy: purely relative cursor movement, no absolute
 * positioning and no terminal scroll-region (DECSTBM). The invariant:
 * outside of a draw/write call, the cursor sits at column 1 of the "base"
 * row (just below the last output line). To redraw, jump up from base by
 * the header's last-known height (`promptLines` — not a fixed constant,
 * since the panel can render taller than the input box) via cursorUp(),
 * overwrite in place, jump back down. This is correct regardless of how
 * much the terminal has natively scrolled — because it never assumes
 * anything about absolute screen position — AND it never restricts what
 * the terminal considers scrollable, so tool-log history stays genuinely
 * scrollable.
 *
 * This only stays correct if EVERY line printed while the TUI is active
 * goes through writeOutput() below — a stray console.log/readline
 * bypasses this module's bookkeeping and desyncs the next redraw. The
 * permission-confirmation prompt used to do exactly that (a plain
 * readline.Interface, which also fights the TUI's raw-mode stdin handler);
 * askConfirm() below replaces it for TUI mode — see
 * safety/permissions.ts's setConfirmHandler().
 *
 * The user can type at any time. Ctrl+C aborts the current task.
 */
import chalk from 'chalk';
import type { Display } from './display.js';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';
import { formatContextBar, formatContextDashboard } from './context-health.js';
import { gradient, gradientStopFor, GOLD_HEX, GOLD_DIM_HEX, RUBY_ACCENT } from './diamond.js';

const GOLD = chalk.hex(GOLD_HEX);
const GOLD_DIM = chalk.hex(GOLD_DIM_HEX);
const ACCENT = chalk.hex('#cc785c');

/** HH:MM AM/PM, for the message-bubble timestamp under an echoed user line. */
function formatTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// ── State ──────────────────────────────────────────────────────────────────

let inputBuffer = '';
let cursorPos = 0;
let inputActive = false;
let stdinHandler: ((data: string) => void) | null = null;
let chatId = '';
let promptLines = 0; // how many rows the header actually takes
let outputLine = 0;  // how many lines of output have been written since initTui()

// ── Scroll mode ────────────────────────────────────────────────────────────
//
// The alt screen (see enterAltScreen()) has no native scrollback, so the TUI
// keeps its own: every physical output row that goes through writeOutput()
// (which, via patchStdout(), is every row from anywhere in the process) is
// also appended to `scrollBuffer`.
//
// The TUI is MODAL, borrowing vim's semantics wholesale (confirmed design —
// the audience is power users who already know vim):
//   INPUT mode (default) — typing goes into the task box; j/k/g/G are just
//     letters. The metadata line under the box shows "-- INSERT --".
//   SCROLL mode — Esc from INPUT mode at any time (composing or not; the
//     draft is preserved). The input box stays visible but loses focus
//     (dimmed border, no cursor block), history becomes a vim-keyed pager
//     below it: j/k line, Ctrl+d/u half-page, gg top, G bottom (stays in
//     SCROLL, showing the live tail). i, Enter, or Esc again returns to
//     INPUT and refocuses the box. The bottom row shows "-- SCROLL --" plus
//     position — the mode is always visible at a glance, in both states.
// A bare j/k press never switches modes: with the box focused there is no
// state in which a j keystroke is unambiguously "scroll" rather than the
// first letter of a task like "just do X".
let scrollMode = false;
let scrollOffset = 0;       // rows scrolled up from the bottom of the buffer (0 = live tail)
let pendingG = false;       // first 'g' of a 'gg' (jump to top) seen
let scrollBuffer: string[] = []; // hard-wrapped physical rows, oldest first
const MAX_SCROLLBACK = 5000;
let streamAccum = '';       // streamed tokens not yet newline-terminated (flushed to scrollBuffer on stream end)
let bannerLines: string[] = []; // startup banner copy, for repainting after scroll mode

/**
 * Give the TUI its own copy of the startup banner rows so it can repaint
 * them when it rebuilds the screen after scroll mode — on the alt screen
 * there's no scrollback to recover the banner from once it's overwritten.
 */
export function setBannerLines(lines: string[]): void {
  bannerLines = lines;
}

function pushScrollback(lines: string[]): void {
  for (const line of lines) scrollBuffer.push(line);
  if (scrollBuffer.length > MAX_SCROLLBACK) {
    scrollBuffer.splice(0, scrollBuffer.length - MAX_SCROLLBACK);
  }
}

let onEnter: ((line: string) => void) | null = null;
let onStop: (() => void) | null = null;
let currentAbort: AbortController | null = null;
/** Set while askConfirm() is awaiting an answer — the next Enter resolves it instead of dispatching a task. */
let pendingConfirm: ((answer: string) => void) | null = null;

// ── Status footer ──────────────────────────────────────────────────────────
//
// A persistent one-line status bar (token/cost/turn stats) anchored to the
// bottom of the output — not scrolled away with history. Deliberately NOT
// implemented via a terminal scroll region (DECSTBM): reserving a bottom
// row that way forces the cursor to the region's home position the moment
// it's set, which would overwrite the startup banner sitting above the
// header. Instead the footer just lives on the current "base" row (see the
// invariant in the file header comment) and gets pushed down one row,
// in place, every time real output is written — the same overwrite-in-place
// technique already used for the thinking spinner.
let footerActive = false;
let footerText = '';

/**
 * Redraw the footer on whatever row the cursor currently sits on. No-op if
 * no footer is set yet. Truncated (not wrapped) to fit one line — the
 * footer is meant to be a single-row persistent status bar; an untruncated
 * long footer would auto-wrap in a narrow terminal, silently consuming a
 * second physical row the header's cursor math doesn't know about (this
 * broke the "always exactly one row" footer invariant until fixed).
 */
function redrawFooterInPlace(): void {
  if (!footerActive || scrollMode) return;
  cursorCol(1);
  clearEol();
  rawWrite(truncVisible(footerText, Math.max(10, cols() - MARGIN)));
}

/** Set/update the persistent bottom status line. Safe to call repeatedly (e.g. once per turn). */
export function setFooter(text: string): void {
  footerText = text;
  footerActive = true;
  if (inputActive) redrawFooterInPlace();
}

let panelSuggestions: string[] = [];

/**
 * Feed the right-side panel's "Try" suggestions. Safe to call before
 * initTui(). The panel is Try-only by design: the Commands/Skills sections
 * it used to carry were informational clutter next to the input — the
 * actual command list lives in :help and doesn't need permanent sidebar
 * space.
 */
export function setPanelContent(opts: { suggestions?: string[] }): void {
  if (opts.suggestions) panelSuggestions = opts.suggestions;
  if (inputActive) drawPromptTop();
}

/** An unboxed metadata line rendered directly below the input box (mode/model/provider). */
let statusLineText = '';
export function setStatusLine(text: string): void {
  statusLineText = text;
  if (inputActive) drawPromptTop();
}

export function createAbortController(): AbortController {
  currentAbort = new AbortController();
  return currentAbort;
}
export function clearAbortController(): void { currentAbort = null; }

// ── Low-level ──────────────────────────────────────────────────────────────
//
// Every write this module makes to the terminal goes through rawWrite(),
// which always hits the REAL process.stdout.write — bypassing the
// interception installed below by patchStdout(). This distinction matters:
// this module's own writes (cursor moves, the header, writeOutput's
// content) are already wrap-aware and bookkept correctly; everything else
// in the process — console.log from any of the ~30 REPL commands, a
// side-channel renderer, a future feature nobody remembers to route
// through writeOutput() — is NOT. Those stray writers used to silently
// desync the header's cursor math (a multi-line console.log, e.g. the
// :btw answer box, consumes several physical rows that the header had no
// way of knowing about), which is what caused the header to visibly stack
// into duplicate frames again after every other fix in this file. Rather
// than hunt down and fix every current and future call site individually,
// patchStdout() intercepts process.stdout.write globally while the TUI is
// active and routes anything that isn't from this module through the same
// wrap-aware writeOutput() path automatically.
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

/**
 * Enter the terminal's alternate screen buffer (the same mechanism vim,
 * htop, less, and tmux itself use) — DECSTBM's cursor-reset problem doesn't
 * apply here; this is a full screen swap, not a scroll-region trick. This
 * exists because "redraw the header in place on the normal screen" has a
 * structural flaw no amount of cursor-math correctness can fix: the header
 * is redrawn on every keystroke, but the terminal's REAL scrollback only
 * grows when content actually scrolls past the top of the visible
 * viewport — and every one of those keystroke-triggered redraws that
 * happens to scroll off becomes a permanently frozen, stale copy in that
 * scrollback. The live view was always correct; scrolling UP through
 * history showed dozens of stale intermediate frames baked in over time.
 * The alternate screen buffer sidesteps this entirely: it's an isolated
 * virtual screen with no persistent scrollback of its own, so repeated
 * redraws just overwrite the same virtual rows forever, and the instant
 * this process leaves the alt screen (leaveAltScreen()), the terminal
 * reverts to exactly whatever was showing before — no trace left behind,
 * same as quitting vim or less. Trade-off: native mouse-wheel scrollback
 * through old tool-call output is no longer available (there's nothing to
 * scroll into). The TUI's own scroll mode (see the "Scroll mode" section)
 * replaces it: Esc/Up from an idle prompt opens a vim-keyed pager over
 * everything written since startup, and past turns are also on disk via
 * the session store (:sessions/:resume).
 */
let altScreenActive = false;
export function enterAltScreen(): void { altScreenActive = true; rawWrite('\x1b[?1049h'); }
/** Leave the alternate screen buffer, restoring whatever was on screen before enterAltScreen(). No-op if never entered. */
export function leaveAltScreen(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  rawWrite('\x1b[?1049l');
}

const cols = () => process.stdout.columns ?? 80;

/**
 * Anything that reaches here came from outside this module (console.log,
 * a stray process.stdout.write elsewhere, etc.) while the TUI owns the
 * screen. console.log always emits its formatted string plus exactly one
 * trailing '\n' in a single write call, so routing a newline-terminated
 * chunk through writeOutput() (which already hard-wraps and multi-line
 * embedded '\n' correctly) handles the dominant real case. A chunk that
 * does NOT end in '\n' (a genuine partial/no-newline write, rare in this
 * codebase) is passed through raw as an in-progress line — same treatment
 * writeStream() gives streamed tokens.
 */
function handleExternalWrite(chunk: string): void {
  if (!inputActive) { rawWrite(chunk); return; }
  if (chunk.endsWith('\n')) {
    writeOutput(chunk.slice(0, -1));
  } else if (scrollMode) {
    streamAccum += chunk; // partial line while the pager owns the screen — hold it like a streamed token
  } else {
    rawWrite(chunk);
  }
}

/** Start intercepting process.stdout.write so external writers can't desync the header. */
function patchStdout(): void {
  if (realStdoutWrite) return;
  realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    handleExternalWrite(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

/** Restore the real process.stdout.write. Always call before leaving TUI mode. */
function unpatchStdout(): void {
  if (realStdoutWrite) {
    process.stdout.write = realStdoutWrite;
    realStdoutWrite = null;
  }
}

// Safety net: never leave the process with a patched stdout or the user's
// real terminal stuck on the alternate screen if we exit unexpectedly
// (crash, unhandled rejection, etc).
process.on('exit', () => {
  try { leaveAltScreen(); unpatchStdout(); } catch { /* best effort */ }
});

// ── Header layout ────────────────────────────────────────────────────────

// Input box: 1 top border + 5 content rows + 1 bottom border — tall enough
// that multi-line task entry doesn't feel cramped (raised from the earlier
// compact 2-content-row box by design; wrapInput() scrolls if a draft
// outgrows even this).
const HEADER_ROWS = 7;
const BOX_CONTENT_ROWS = HEADER_ROWS - 2; // minus top/bottom border rows

interface Layout {
  boxWidth: number;
  showPanel: boolean;
  panelWidth: number;
}

// Every rendered row is built as: LEAD + box(boxWidth) + [GAP + panel(panelWidth)].
// MARGIN keeps total visible width at least 1 column short of the terminal
// width on every row — writing exactly to (or past) the last column forces
// an automatic terminal wrap, which silently inserts a physical row this
// module's relative cursor math doesn't know about. That mismatch is what
// caused the header to visibly stack into multiple overlapping frames on
// every redraw (i.e. every keystroke) once the layout math allowed a row
// to reach the full terminal width — always leave the margin.
const LEAD = 2;
const GAP = 2;
const MARGIN = 1;

function computeLayout(): Layout {
  const total = cols();
  const minBox = 28;
  const minPanel = 22;

  if (total - LEAD - MARGIN < minBox + GAP + minPanel) {
    // Too narrow for the panel — box alone, widened to fill the terminal.
    return { boxWidth: Math.min(total - LEAD - MARGIN, 100), showPanel: false, panelWidth: 0 };
  }
  const boxWidth = Math.max(minBox, Math.min(70, Math.floor(total * 0.55)));
  const panelWidth = total - LEAD - boxWidth - GAP - MARGIN;
  return { boxWidth, showPanel: true, panelWidth };
}

/** Word-wrap the input buffer into BOX_CONTENT_ROWS rows of `innerWidth` chars, scrolling if longer. */
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

/**
 * Build the panel's content lines: a title row per non-empty section, then
 * one row per item ("· :dream"). Not capped at HEADER_ROWS — the panel's
 * height is independent of the (fixed, compact) input box's height, so it
 * can extend further down alongside the box, matching the reference
 * layout where the sidebar visibly outlasts the compact input box.
 */
function buildPanelLines(width: number): string[] {
  if (panelSuggestions.length === 0) return [];
  const trunc = (s: string) => s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s;
  const lines: string[] = [trunc(ACCENT.bold('Try'))];
  for (const item of panelSuggestions) lines.push(trunc(GOLD(`· ${item}`)));
  return lines;
}

// ── Prompt rendering ───────────────────────────────────────────────────────

function padVisible(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return s + ' '.repeat(Math.max(0, width - visibleLen));
}

/** Truncate to a single line of at most `width` visible chars (ANSI-code aware), with an ellipsis if cut. */
function truncVisible(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
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
 * Compute the full header's lines: the input box (HEADER_ROWS, fixed), an
 * unboxed status-line row directly under it, then the right-side panel
 * alongside — which may run taller than the box+status rows combined, in
 * which case the left column below the status line is left blank while the
 * panel keeps going. Total row count is NOT fixed — it's
 * max(HEADER_ROWS + 1, panelLines.length) — see drawPromptTop()/initTui()
 * for how the variable height is tracked across redraws (via `promptLines`,
 * not a compile-time constant).
 */
function buildHeaderRows(): string[] {
  const layout = computeLayout();
  const { boxWidth, showPanel, panelWidth } = layout;
  const idTag = chatId ? ` ${chatId}` : '';
  const label = ` ask aura${idTag} `;
  const innerWidth = boxWidth - 4;
  const wrapped = wrapInput(innerWidth);
  // Focus follows the mode: in SCROLL mode the box stays visible but loses
  // focus — dimmed border, no cursor block — so the modality is visible in
  // the box itself, not only in the mode tag below it.
  const focused = !scrollMode;
  const cursorChar = focused ? ACCENT('█') : '';
  const panelLines = showPanel ? buildPanelLines(panelWidth) : [];
  const totalRows = Math.max(HEADER_ROWS + 1, panelLines.length);

  const rows: string[] = [];
  for (let row = 0; row < totalRows; row++) {
    let leftPart: string;
    if (row < HEADER_ROWS) {
      // Thin border — a subtle box, not a heavy/bold one (matches the
      // reference; this reverses an earlier "make lines stronger" round).
      let boxPart: string;
      if (row === 0) {
        const dashes = Math.max(0, boxWidth - label.length - 2);
        boxPart = focused
          ? gradient('╭') + GOLD_DIM(label) + gradient('─'.repeat(dashes)) + gradient('╮')
          : GOLD_DIM('╭' + label + '─'.repeat(dashes) + '╮');
      } else if (row === HEADER_ROWS - 1) {
        boxPart = focused
          ? gradient('╰' + '─'.repeat(boxWidth - 2) + '╯')
          : GOLD_DIM('╰' + '─'.repeat(boxWidth - 2) + '╯');
      } else {
        const contentRow = row - 1;
        const text = wrapped.rows[contentRow] ?? '';
        const isCursorRow = contentRow === wrapped.cursorRow;
        const showPlaceholder = inputBuffer.length === 0 && contentRow === 0;
        let inner: string;
        if (showPlaceholder) {
          inner = GOLD_DIM('type a task, :btw, :q, :help...') + cursorChar;
          inner = padVisible(inner, innerWidth);
        } else if (isCursorRow && focused) {
          const before = GOLD(text.slice(0, wrapped.cursorCol));
          const after = GOLD(text.slice(wrapped.cursorCol));
          inner = padVisible(before + cursorChar + after, innerWidth);
        } else {
          // Unfocused: the draft stays visible (it's preserved across the
          // mode switch) but dimmed, with no cursor block.
          inner = padVisible((focused ? GOLD : GOLD_DIM)(text), innerWidth);
        }
        const border = focused ? gradientStopFor(row, HEADER_ROWS)('│') : GOLD_DIM('│');
        // border + space + inner + space + border == innerWidth + 4 == boxWidth,
        // matching the top/bottom border rows exactly — keeping every row's
        // exact width accounted for, see the LEAD/GAP/MARGIN comment above.
        boxPart = border + ' ' + inner + ' ' + border;
      }
      leftPart = ' '.repeat(LEAD) + boxPart;
    } else if (row === HEADER_ROWS) {
      // Unboxed metadata line directly below the closed box: the mandatory
      // vim-style mode tag first, then mode/model/provider.
      const modeTag = focused ? ACCENT.bold('-- INSERT --') : ACCENT.bold('-- SCROLL --');
      leftPart = ' '.repeat(LEAD) + padVisible(modeTag + GOLD_DIM(` ${statusLineText}`), boxWidth);
    } else {
      // Box (and status line) have ended; the panel keeps going alone.
      leftPart = ' '.repeat(LEAD + boxWidth);
    }

    let line = leftPart;
    if (showPanel && panelLines[row] !== undefined) {
      line += ' '.repeat(GAP) + panelLines[row];
    }
    rows.push(line);
  }
  return rows;
}

/**
 * Redraw the header IN PLACE: jump up from the current base row by exactly
 * (promptLines + outputLine) — the number of rows the header+output occupy
 * above it, where `promptLines` is however many rows the header actually
 * took on its LAST draw (not a fixed constant — the panel can be taller
 * than the input box, see buildHeaderRows()) — overwrite each header row,
 * then return to base. Purely relative to the cursor's current position, so
 * it's correct no matter how much the terminal has scrolled since the last
 * draw, and it never touches the terminal's scroll region — native
 * scrollback stays fully intact.
 */
function drawPromptTop(): void {
  if (scrollMode) return; // scroll mode owns the whole screen; live view is rebuilt on exit
  const rows = buildHeaderRows();
  cursorUp(promptLines + outputLine);
  rows.forEach((line, i) => {
    cursorCol(1);
    clearEol();
    rawWrite(line);
    if (i < rows.length - 1) cursorDown(1);
  });
  // Currently on the last header row just drawn; step back down to base.
  // outputLine rows below it, regardless of how tall the header turned out
  // to be this time — only the UP jump above needed the old height.
  cursorDown(outputLine + 1);
  cursorCol(1);
  promptLines = rows.length;
}

// ── Output ─────────────────────────────────────────────────────────────────

/**
 * Split `text` into physical terminal lines and report how many there are.
 * Two things can make one logical writeOutput() call consume more than one
 * physical row, and both used to silently break the header's cursor math
 * (which assumed exactly 1 row per call): (1) callers that already embed
 * '\n' (e.g. a multi-line tool-result preview), and (2) any single line
 * whose visible width exceeds the terminal — the terminal auto-wraps it,
 * inserting a row the old fixed "+1" never accounted for. Hard-wrapping
 * here instead of letting the terminal do it means we always know exactly
 * how many rows were consumed. ANSI-code-aware: escape sequences are
 * carried across a wrap point rather than being split mid-sequence or
 * dropped, so color state isn't corrupted at the cut.
 */
function wrapForTerminal(text: string): { output: string; lineCount: number } {
  const maxWidth = Math.max(10, cols() - MARGIN);
  const physicalLines: string[] = [];
  for (const line of text.split('\n')) {
    // eslint-disable-next-line no-control-regex
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

/**
 * Write a line of output below the prompt. Assumes the cursor is at "base"
 * (see the file header comment) — true between calls thanks to the
 * invariant every exported function here maintains. This is the correct
 * way for THIS module to print; anything else in the process (console.log,
 * a stray process.stdout.write) goes through patchStdout()'s interception
 * instead, which itself calls this function — see the "Low-level" section.
 */
export function writeOutput(text: string): void {
  // An unterminated streamed line about to be visually overwritten below —
  // preserve it in the scrollback first so scroll mode doesn't lose it.
  if (streamAccum) {
    pushScrollback(wrapForTerminal(streamAccum).output.split('\n'));
    streamAccum = '';
  }
  const { output, lineCount } = wrapForTerminal(text);
  pushScrollback(output.split('\n'));
  if (scrollMode) {
    // The user is reading history — append to the buffer only, and grow the
    // offset by the same amount so the visible window stays anchored on the
    // content they're reading instead of sliding as new output arrives.
    scrollOffset = Math.min(scrollOffset + lineCount, maxScrollOffset());
    renderScrollView();
    return;
  }
  cursorCol(1);
  clearEol();
  rawWrite(output);
  rawWrite('\n');
  outputLine += lineCount;
  // The footer (if set) lived on the row we just wrote over — redraw it on
  // the fresh row below, keeping it pinned to the bottom of the output.
  redrawFooterInPlace();
  // Re-pin the header immediately above the new base. If the terminal was
  // full, the '\n' above already scrolled everything (header included)
  // natively — this just re-expresses the header at its new relative
  // position, which is correct either way since it's not based on any
  // absolute row, and doesn't interfere with native scrollback.
  drawPromptTop();
}

/** Streaming text — appends to current output line. Accumulated so the
 * finished line can be added to the scrollback (streamed rows would
 * otherwise be invisible to scroll mode), and suppressed on screen while
 * scroll mode owns the display. */
export function writeStream(text: string): void {
  streamAccum += text;
  if (scrollMode) return;
  rawWrite(text);
}

/**
 * Echo a submitted task as a chat-style "bubble": a ruby accent bar beside
 * the message text, then a dim timestamp on the line below — matching the
 * reference layout's message log, instead of a plain "❯ text" line.
 */
function echoUserLine(line: string): void {
  const bar = RUBY_ACCENT('│ ');
  writeOutput(bar + GOLD(line));
  writeOutput(bar + GOLD_DIM(formatTime(new Date())));
}

// ── Scroll-mode rendering ──────────────────────────────────────────────────

const screenRows = () => process.stdout.rows ?? 24;

/**
 * Pager rows available in scroll mode — the screen minus the (still
 * visible, dimmed) header block on top and the mode-indicator row at the
 * bottom. Uses `promptLines` (the header's height as of its last build),
 * which renderScrollView() keeps in sync each repaint.
 */
function viewHeight(): number {
  return Math.max(3, screenRows() - promptLines - 1);
}

function maxScrollOffset(): number {
  return Math.max(0, scrollBuffer.length - viewHeight());
}

/**
 * Repaint the whole screen for SCROLL mode: the header block stays pinned
 * on top (buildHeaderRows() renders it unfocused — dimmed border, no
 * cursor, "-- SCROLL --" tag — since scrollMode is set), the pager window
 * over scrollBuffer below it, and the mode indicator pinned to the bottom
 * row (written without a trailing newline so it can't scroll the view).
 * Buffer rows were hard-wrapped to the width at write time, but the
 * terminal may have been resized narrower since — truncate per row rather
 * than letting an autowrap silently double a row.
 */
function renderScrollView(): void {
  const headerRows = buildHeaderRows();
  promptLines = headerRows.length; // keep viewHeight()'s basis in sync with what's actually drawn
  const vh = viewHeight();
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxScrollOffset()));
  const start = Math.max(0, scrollBuffer.length - vh - scrollOffset);
  const visible = scrollBuffer.slice(start, start + vh);
  const width = Math.max(10, cols() - MARGIN);

  rawWrite('\x1b[2J\x1b[H');
  headerRows.forEach(line => { rawWrite(line); rawWrite('\n'); });
  visible.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });
  for (let i = visible.length; i < vh; i++) rawWrite('\n');

  const bottom = start + visible.length;
  const pos = scrollOffset === 0 ? 'BOT' : start === 0 ? 'TOP' : `${Math.round((bottom / Math.max(1, scrollBuffer.length)) * 100)}%`;
  const indicator = ACCENT.bold(' -- SCROLL -- ')
    + GOLD_DIM(`${start + 1}-${bottom}/${scrollBuffer.length} ${pos} · j/k line · ^d/^u half-page · gg/G top/bottom · i/Enter/Esc insert`);
  rawWrite(truncVisible(indicator, width));
}

function enterScrollMode(initialOffset: number): void {
  if (scrollBuffer.length === 0) return; // nothing to scroll into yet
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

/**
 * Rebuild the live view from scratch after scroll mode released the screen:
 * banner (the TUI's saved copy — skipped if the terminal is too short to
 * leave a few output rows under it), header, then as much of the output
 * tail as fits, footer on the base row. Ends with the cursor at column 1 of
 * the base row, re-establishing the invariant from the file header comment;
 * promptLines/outputLine are reset to describe exactly what was repainted.
 */
function redrawLiveView(): void {
  rawWrite('\x1b[2J\x1b[H');
  const headerRows = buildHeaderRows();
  const sr = screenRows();
  const width = Math.max(10, cols() - MARGIN);
  const withBanner = bannerLines.length > 0 && sr - bannerLines.length - headerRows.length - 1 >= 3;
  const banner = withBanner ? bannerLines : [];
  const tailMax = Math.max(0, sr - banner.length - headerRows.length - 1);
  const tail = scrollBuffer.slice(Math.max(0, scrollBuffer.length - tailMax));

  banner.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });
  headerRows.forEach(line => { rawWrite(line); rawWrite('\n'); });
  tail.forEach(line => { rawWrite(truncVisible(line, width)); rawWrite('\n'); });

  promptLines = headerRows.length;
  outputLine = tail.length;
  redrawFooterInPlace();
  cursorCol(1);
}

/**
 * Ask a yes/no question through the TUI's own raw-mode input instead of a
 * plain readline.Interface. A second readline on the same stdin forces raw
 * mode off (and never restores it), which fights this module's own 'data'
 * handler — garbled echo, dropped keys, corrupted redraws. This borrows the
 * next Enter-terminated line as the answer instead of dispatching it as a
 * new task, then restores normal input handling.
 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise(resolve => {
    writeOutput(chalk.hex('#d4903a')(`  ⚠  ${message} [y/N]`));
    pendingConfirm = (answer: string) => {
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    };
  });
}

// ── Input handling ─────────────────────────────────────────────────────────

function handleChar(ch: string): void {
  if (ch === '\x03') {
    if (pendingConfirm) {
      const resolve = pendingConfirm;
      pendingConfirm = null;
      inputBuffer = '';
      cursorPos = 0;
      writeOutput(GOLD_DIM('❯ n (cancelled)'));
      resolve('n');
      return;
    }
    if (currentAbort && !currentAbort.signal.aborted) {
      currentAbort.abort();
      writeOutput(chalk.hex('#d4903a')('  ⏹ Aborting current task...'));
      if (onStop) onStop();
      return;
    }
    unpatchStdout();
    leaveAltScreen();
    showCursor();
    process.exit(0);
  }

  if (ch === '\r' || ch === '\n') {
    const line = inputBuffer.trim();

    if (pendingConfirm) {
      const resolve = pendingConfirm;
      pendingConfirm = null;
      writeOutput(GOLD_DIM(`❯ ${line || 'n'}`));
      inputBuffer = '';
      cursorPos = 0;
      drawPromptTop();
      resolve(line);
      return;
    }

    if (line) {
      echoUserLine(line);
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

/**
 * One decoded key in scroll mode. Every binding here is scroll-mode-only —
 * none of these can shadow task text, because printable keys only reach
 * this function after the mode switch (see handleKey()).
 */
function handleScrollKey(key: string): void {
  const half = Math.floor(viewHeight() / 2);
  const gWasPending = pendingG;
  pendingG = false;
  switch (key) {
    case 'g':
      if (!gWasPending) { pendingG = true; return; }
      scrollOffset = maxScrollOffset(); // gg — top of history
      break;
    case 'k': case '\x1b[A': scrollOffset += 1; break;
    case 'j': case '\x1b[B': scrollOffset -= 1; break;
    case '\x15': case '\x1b[5~': scrollOffset += half; break; // Ctrl+u / PageUp
    case '\x04': case '\x1b[6~': scrollOffset -= half; break; // Ctrl+d / PageDown
    case 'G': scrollOffset = 0; break; // jump to bottom (live tail) — stays in SCROLL mode
    case 'i':                       // vim: back to insert, refocus the input box
    case 'q': case '\x1b': case '\r': case '\n':
    case '\x03':                    // Ctrl+C exits scroll mode, not the app
      exitScrollMode();
      return;
    default:
      return; // unbound key — ignore, stay where we are
  }
  renderScrollView(); // clamps the offset
}

/**
 * One decoded key (single char or a whole ESC sequence) in INPUT mode.
 * Esc leaves input focus and enters SCROLL mode at any time — mid-draft
 * included; the draft is preserved (still visible, dimmed) and restored
 * on refocus. Up-arrow from an idle (empty) prompt and PageUp anytime
 * also enter SCROLL mode. Never a bare j/k, which must stay typeable as
 * the first letter of a task ("just do X"). Inside scroll mode the full
 * vim set applies; see handleScrollKey().
 */
function handleKey(key: string): void {
  if (scrollMode) { handleScrollKey(key); return; }

  if (key === '\x1b') {
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
  if (key === '\x1b[D') { // Left — move the input cursor
    if (cursorPos > 0) { cursorPos--; drawPromptTop(); }
    return;
  }
  if (key === '\x1b[C') { // Right
    if (cursorPos < inputBuffer.length) { cursorPos++; drawPromptTop(); }
    return;
  }
  if (key.length > 1) return; // other ESC sequences — swallow, don't type garbage
  handleChar(key);
}

/**
 * Decode the raw stdin chunk into keys before dispatching: an arrow/page
 * key arrives as a multi-byte ESC sequence ("\x1b[A"), which the old
 * char-by-char loop shredded into printable garbage ("[A") typed into the
 * input box. A lone \x1b (no sequence following in the same chunk) is the
 * Esc key itself.
 */
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

export function setCallbacks(opts: { onEnter: (line: string) => void; onStop?: () => void }): void {
  onEnter = opts.onEnter;
  onStop = opts.onStop ?? null;
}

export function setChatId(id: string): void {
  chatId = id;
}

export function initTui(): void {
  // Don't clear the screen — banner from renderBanner() is already there.
  // This is the one place we draw forward (with real newlines) instead of
  // jumping to an anchor: there's no existing header on screen yet to jump
  // up from, so we print it top-to-bottom right where the cursor already
  // is (just after the banner), which leaves the cursor at column 1 of the
  // base row — establishing the invariant every other function relies on.
  outputLine = 0;
  scrollMode = false;
  scrollOffset = 0;
  pendingG = false;
  scrollBuffer = [];
  streamAccum = '';
  hideCursor();
  const rows = buildHeaderRows();
  rows.forEach(line => { rawWrite(line); rawWrite('\n'); });
  promptLines = rows.length;
  // Intercept process.stdout.write from here on — any writer other than
  // this module (console.log from a REPL command, etc.) now gets routed
  // through writeOutput()'s wrap-aware bookkeeping instead of silently
  // desyncing the header. See the "Low-level" section for why.
  patchStdout();
  // A divider between the pinned header and the scrollable log below it —
  // this one line scrolls away with everything else, it's just a visual
  // frame under the header the first time it's drawn.
  writeOutput(gradient('─'.repeat(Math.min(cols(), 100))));
}

export function destroyTui(): void {
  scrollMode = false;
  stopInput();
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

  return {
    agentThinking() {
      // Show a subtle spinner on its own line — cursor is already at base
      // (invariant), so just overwrite this line in place; outputLine
      // doesn't advance since the spinner line gets reused/overwritten.
      // Note: this temporarily overwrites the footer if one is showing
      // (both live on the same "base" row while idle) — it reappears as
      // soon as the next real writeOutput()/streamEnd() call redraws it.
      if (scrollMode) return; // scroll mode owns the screen; the spinner is transient anyway
      const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const s = spinners[(thinkingFrame++) % spinners.length];
      cursorCol(1);
      clearEol();
      rawWrite(GOLD_DIM(`  ${s} thinking`));
      cursorCol(1);
    },
    toolStart() {},

    streamText(text: string) {
      if (!inStream) {
        inStream = true;
        // Cursor is already at base — just clear the (possibly spinner-
        // occupied) line before appending the stream. (Skipped in scroll
        // mode — writeStream() buffers the tokens without touching the
        // screen until the user returns to the live tail.)
        if (!scrollMode) {
          cursorCol(1);
          clearEol();
        }
      }
      // KNOWN GAP: unlike writeOutput(), this doesn't hard-wrap long lines
      // (would need to buffer the accumulated streamed text to know when a
      // line has exceeded terminal width — chunks arrive piecemeal). A
      // streamed response line longer than the terminal width will
      // auto-wrap in the terminal without streamEnd()'s outputLine++
      // accounting for the extra row. Not yet hit in practice; if it
      // surfaces as header desync during long unbroken streamed lines,
      // this is where to fix it.
      writeStream(GOLD(text));
    },

    streamEnd() {
      if (inStream) {
        // The finished streamed line joins the scrollback (it never went
        // through writeOutput, so nothing else records it).
        if (streamAccum) {
          pushScrollback(wrapForTerminal(streamAccum).output.split('\n'));
          streamAccum = '';
        }
        inStream = false;
        if (scrollMode) return; // nothing on screen to terminate — tokens were buffered
        rawWrite('\n');
        outputLine++;
        redrawFooterInPlace();
        drawPromptTop();
      }
    },

    toolCall(name: string, input: Record<string, unknown>) {
      const icon = toolIcon(name);
      const label = chalk.hex('#cc785c').bold(`${icon} ${name}`);
      const detail = fmtIn(name, input);
      writeOutput(`  ${label}  ${GOLD_DIM(detail)}`);
    },

    toolResult(name: string, result: string, elapsedMs: number) {
      const lines = result.split('\n');
      const preview = lines.length > 8
        ? lines.slice(0, 8).join('\n') + GOLD_DIM(`\n  ... (${lines.length - 8} more lines)`)
        : result;
      const elapsed = GOLD_DIM(`${elapsedMs}ms`);
      const isError = result.startsWith('Error:') || result.startsWith('Tool error');
      if (isError) {
        writeOutput('  ' + chalk.hex('#b15439')('✗ ') + GOLD_DIM(preview.replace(/\n/g, '\n    ')));
      } else {
        const fl = lines[0] ?? '';
        if (lines.length <= 3) {
          writeOutput('  ' + chalk.hex('#5a9e6e')('✓ ') + GOLD_DIM(result));
        } else {
          writeOutput('  ' + chalk.hex('#5a9e6e')('✓ ') + GOLD_DIM(`${fl}`) + GOLD_DIM(` (+${lines.length - 1} lines) ${elapsed}`));
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
      writeOutput('\n' + l);
      writeOutput(chalk.hex('#cc785c').bold(`  ${title}`));
      if (subtitle) writeOutput(GOLD_DIM(`  ${subtitle}`));
      writeOutput(l);
    },

    summary(text: string, turns: number, toolCount: number) {
      const l = sep();
      writeOutput('\n' + l);
      writeOutput(chalk.hex('#5a9e6e').bold('  ✓ Done'));
      writeOutput(GOLD_DIM(`  ${turns} turn${turns > 1 ? 's' : ''} · ${toolCount} tool call${toolCount > 1 ? 's' : ''}`));
      if (text) {
        writeOutput('');
        text.split('\n').forEach(lx => writeOutput(GOLD(`  ${lx}`)));
      }
      writeOutput(l + '\n');
    },

    showPlan(plan: ExecutionPlan) {
      const l = sep();
      const idxMap = new Map<string, number>(plan.steps.map((s, i) => [s.id, i + 1]));
      writeOutput('\n' + l);
      writeOutput(chalk.hex('#cc785c').bold('  Execution Plan'));
      writeOutput(GOLD_DIM(`  Goal: ${plan.goal}`));
      writeOutput(l);
      plan.steps.forEach((s, i) => {
        const num  = GOLD_DIM(`${i + 1}.`);
        const spec = chalk.hex('#cc785c').bold(`[${s.specialist}]`);
        const task = GOLD(s.task.length > 55 ? s.task.slice(0, 52) + '…' : s.task);
        const deps = s.dependsOn.length > 0
          ? GOLD_DIM(` ← ${s.dependsOn.map(d => idxMap.get(d) ?? '?').join(', ')}`)
          : '';
        writeOutput(`  ${num} ${spec} ${task}${deps}`);
      });
      writeOutput(l + '\n');
    },

    stepStarted(step: PlanStep) {
      const spec = chalk.hex('#d4903a').bold(`[${step.specialist}]`);
      const task = GOLD_DIM(step.task.length > 70 ? step.task.slice(0, 67) + '…' : step.task);
      writeOutput('\n' + chalk.hex('#d4903a')('  →') + ` ${spec} ${task}`);
    },

    stepCompleted(step: PlanStep) {
      const spec = chalk.hex('#5a9e6e').bold(`[${step.specialist}]`);
      const ms   = step.durationMs != null ? `${step.durationMs}ms` : '?ms';
      writeOutput(chalk.hex('#5a9e6e')('  ✓') + ` ${spec} ${GOLD_DIM(`done (${ms})`)}`);
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
      // Pinned to the bottom as a persistent status line (token/cost/turn
      // stats), not scrolled away with the rest of the log — see setFooter().
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

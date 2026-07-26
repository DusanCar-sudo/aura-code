/**
 * Interactive compaction-ladder tuner (`/context tune`).
 *
 * Terminal answer to a draggable threshold handle: the selected rung moves
 * under ←/→ instead of a pointer, which avoids putting the terminal into SGR
 * mouse mode. Mouse tracking would disable native text selection for the
 * whole session — a bad trade for a control used a handful of times.
 *
 * State transitions here are pure so they can be unit-tested without a TTY;
 * runTuner() is the only part that touches stdin.
 */
import chalk from 'chalk';
import { TEXT_DIM_HEX, FAINT_HEX } from './diamond.js';
import { getLadder, setLadder, MIN_RUNG, MAX_RUNG, MIN_GAP } from '../agent/context-policy.js';

/** Percentage-points moved per arrow keypress. Shift-arrow uses COARSE_STEP. */
export const FINE_STEP = 0.01;
export const COARSE_STEP = 0.05;

export interface TunerState {
  /** Working copy — committed to the live policy only on save. */
  ladder: number[];
  /** Index of the rung currently under the cursor. */
  selected: number;
}

export function initTunerState(ladder: readonly number[] = getLadder()): TunerState {
  return { ladder: [...ladder], selected: 0 };
}

/**
 * Move the selected rung by `delta`, clamped so it can never cross (or come
 * within MIN_GAP of) its neighbours — the ordering constraint that keeps
 * rung N always below rung N+1.
 */
export function nudge(state: TunerState, delta: number): TunerState {
  const ladder = [...state.ladder];
  const i = state.selected;
  const lowerBound = i === 0 ? MIN_RUNG : ladder[i - 1] + MIN_GAP;
  const upperBound = i === ladder.length - 1 ? MAX_RUNG : ladder[i + 1] - MIN_GAP;

  const next = Math.min(upperBound, Math.max(lowerBound, ladder[i] + delta));
  // Re-round to whole tenths of a percent so repeated float adds don't drift.
  ladder[i] = Math.round(next * 1000) / 1000;
  return { ...state, ladder };
}

/** Move the cursor between rungs, wrapping at both ends. */
export function cycle(state: TunerState, dir: 1 | -1): TunerState {
  const n = state.ladder.length;
  return { ...state, selected: (state.selected + dir + n) % n };
}

/** Commit the working ladder to the live policy. Returns the normalized result. */
export function commit(state: TunerState): readonly number[] {
  return setLadder(state.ladder);
}

const BAR_WIDTH = 20;

/**
 * Render the tuner: the same bar shape the footer uses, plus a caret line
 * pointing at the selected rung with its exact token value.
 */
export function renderTuner(
  state: TunerState,
  contextWindow: number,
  usedTokens: number,
): string {
  const usagePercent = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((usagePercent / 100) * BAR_WIDTH)));
  const positions = state.ladder.map(r => Math.min(BAR_WIDTH - 1, Math.floor(r * BAR_WIDTH)));
  const selectedPos = positions[state.selected];

  let bar = '';
  for (let i = 0; i < BAR_WIDTH; i++) {
    const rungIdx = positions.indexOf(i);
    if (rungIdx !== -1) {
      // The selected rung is drawn brighter so it reads as "grabbed".
      bar += rungIdx === state.selected
        ? chalk.hex('#cc785c').bold('┊')
        : chalk.hex(TEXT_DIM_HEX)('┊');
    } else if (i < filled) {
      bar += chalk.hex('#5a9e6e')('█');
    } else {
      bar += chalk.hex(FAINT_HEX)('░');
    }
  }

  const pct = usagePercent.toFixed(0) + '%';
  const tok = (usedTokens / 1000).toFixed(1) + 'k/' + (contextWindow / 1000).toFixed(0) + 'k';
  const barLine = '  ◆ Context: ' + bar + ' ' + pct + ' (' + tok + ')';

  // Caret sits under the selected rung, offset by the bar's own left padding.
  const BAR_OFFSET = '  ◆ Context: '.length;
  const caretLine = ' '.repeat(BAR_OFFSET + selectedPos) + chalk.hex('#cc785c')('▲');

  const rungPct = (state.ladder[state.selected] * 100).toFixed(0) + '%';
  const rungTok = ((state.ladder[state.selected] * contextWindow) / 1000).toFixed(1) + 'k';
  const label = chalk.hex('#cc785c').bold(
    `rung ${state.selected + 1}/${state.ladder.length}: ${rungPct} (${rungTok})`,
  );
  const hint = chalk.hex(FAINT_HEX)('[←/→ adjust · ⇧ coarse · Tab next · ⏎ save · Esc cancel]');

  const all = chalk.hex(TEXT_DIM_HEX)(
    '  ladder: ' + state.ladder.map(r => (r * 100).toFixed(0) + '%').join(' → '),
  );

  return [barLine, caretLine + '  ' + label, all, '  ' + hint].join('\n');
}

export interface TunerIO {
  write(s: string): void;
  /** Resolves with each keypress; the tuner stops reading once it returns. */
  onKey(handler: (key: string) => void): () => void;
  /** Terminal width, for wrap prevention. Defaults to 80 when absent. */
  columns?(): number;
}

/** Visible length, ignoring SGR colour codes. */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Truncate to `width` visible columns, preserving colour codes. A line that
 *  wraps would occupy two terminal rows and desynchronise the cursor-up math
 *  in the redraw, leaving stale frames behind. */
function truncateVisible(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let i = 0, vis = 0, out = '';
  while (i < s.length && vis < width) {
    const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += s[i]; vis++; i++;
  }
  return out + '\x1b[0m';
}

/**
 * Split a raw stdin chunk into individual key tokens.
 *
 * Holding an arrow key coalesces several presses into one 'data' event, so
 * matching the whole chunk against a key would drop every press but the
 * first — the value appears to jump or stick. Escape sequences are consumed
 * whole: CSI (`\x1b[…final`) and SS3 (`\x1bO…`), the latter being what some
 * terminals send for arrows in application cursor mode.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b' && chunk[i + 1] === '[') {
      let j = i + 2;
      // CSI runs until a final byte in @..~
      while (j < chunk.length && !(chunk[j] >= '\x40' && chunk[j] <= '\x7e')) j++;
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else if (chunk[i] === '\x1b' && chunk[i + 1] === 'O' && i + 2 < chunk.length) {
      // SS3: normalize \x1bOD → \x1b[D so callers match one form.
      keys.push('\x1b[' + chunk[i + 2]);
      i += 3;
    } else {
      keys.push(chunk[i]);
      i++;
    }
  }
  return keys;
}

/**
 * Run the tuner against a raw-key source. Resolves with the committed ladder,
 * or null if the user cancelled.
 *
 * Input handling is injected so the caller owns stdin setup/teardown — the
 * TUI has to remove its own handler first, and the plain display path has to
 * put the terminal into raw mode itself.
 */
export function runTuner(
  io: TunerIO,
  contextWindow: number,
  usedTokens: number,
): Promise<readonly number[] | null> {
  return new Promise((resolve) => {
    let state = initTunerState();
    // Rows the last frame occupied, so the next one can overwrite it in place
    // rather than appending a fresh copy per keypress.
    let prevRows = 0;

    const redraw = () => {
      const width = Math.max(20, (io.columns?.() ?? 80) - 1);
      const frame = renderTuner(state, contextWindow, usedTokens)
        .split('\n')
        .map(l => truncateVisible(l, width))
        .join('\n');
      // Cursor up over the previous frame, then clear to end of screen.
      const rewind = prevRows > 0 ? `\x1b[${prevRows}A\x1b[0J` : '';
      io.write(rewind + frame + '\n');
      prevRows = frame.split('\n').length;
    };

    let finished = false;
    const finish = (dispose: () => void, value: readonly number[] | null) => {
      if (finished) return;
      finished = true;
      dispose();
      resolve(value);
    };

    const dispose = io.onKey((chunk) => {
      // Only repaint if something actually changed — stray sequences (mouse
      // reports, bracketed-paste markers) shouldn't cost a frame.
      let changed = false;
      for (const key of splitKeys(chunk)) {
        switch (key) {
          case '\x1b[D': state = nudge(state, -FINE_STEP); break;      // ←
          case '\x1b[C': state = nudge(state, FINE_STEP); break;       // →
          case '\x1b[1;2D': state = nudge(state, -COARSE_STEP); break; // Shift+←
          case '\x1b[1;2C': state = nudge(state, COARSE_STEP); break;  // Shift+→
          case '\t': state = cycle(state, 1); break;
          case '\x1b[Z': state = cycle(state, -1); break;              // Shift+Tab
          case '\r': case '\n':
            if (changed) redraw();          // leave the committed value on screen
            finish(dispose, commit(state));
            return;
          case '\x1b': case '\x03':                                    // Esc / Ctrl+C
            finish(dispose, null);
            return;
          default:
            continue;                       // unmapped — no state change
        }
        changed = true;
      }
      if (changed && !finished) redraw();
    });

    redraw();
  });
}

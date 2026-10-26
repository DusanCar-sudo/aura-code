import type { ReplCommandResult, ReplMode } from './repl-session-commands.js';
import type { Display } from './display.js';

/** The slice of ReplCtx these commands touch. Declared structurally rather
 *  than importing ReplCtx so this module never depends on index.ts. */
export interface ModeCommandCtx {
  mode: ReplMode;
  display: Pick<Display, 'warning'>;
}

/**
 * Matches `:accountant1`, `/accountant-1`, `:accountant2 on`, `/accountant2 off`
 * — returns the normalized family and subcommand, or null when `input` is not
 * an accountant command.
 */
function parseAccountantCommand(input: string): { family: 'accountant1' | 'accountant2'; sub?: 'on' | 'off' } | null {
  const m = input.match(/^[:\/](accountant-?[12])(?:\s+(on|off))?$/);
  if (!m) return null;
  const family = m[1].endsWith('2') ? 'accountant2' : 'accountant1';
  return { family, sub: m[2] as 'on' | 'off' | undefined };
}

/**
 * Returns a result when `input` is a mode command, or null to let the caller's
 * remaining branches try it. Accountant families are handled BEFORE the plain
 * :coder/:gazelle checks so e.g. `:accountant1 off` is never misread.
 */
export function handleModeCommand(input: string, c: ModeCommandCtx): ReplCommandResult | null {
  const acc = parseAccountantCommand(input);
  if (acc) {
    const inFamily = c.mode === acc.family;
    if (acc.sub === 'off') {
      if (!inFamily) {
        c.display.warning(`Not in ${acc.family === 'accountant1' ? 'Accountant One' : 'Accountant Two'} mode.`);
        return { handled: true };
      }
      c.display.warning(`Toggled off ${acc.family === 'accountant1' ? 'Accountant One' : 'Accountant Two'} mode.`);
      return { handled: true, newMode: 'coder' };
    }
    if (acc.sub === 'on') {
      if (inFamily) {
        c.display.warning(`Already in ${acc.family === 'accountant1' ? 'Accountant One' : 'Accountant Two'} mode.`);
        return { handled: true };
      }
      return { handled: true, newMode: acc.family };
    }
    // Bare toggle: switch in, or back out to coder.
    if (inFamily) {
      c.display.warning(`Toggled off ${acc.family === 'accountant1' ? 'Accountant One' : 'Accountant Two'} mode.`);
      return { handled: true, newMode: 'coder' };
    }
    return { handled: true, newMode: acc.family };
  }

  if (input === ':gazelle') {
    if (c.mode === 'gazelle') {
      c.display.warning('Already in conversational (Gazelle) mode.');
      return { handled: true };
    }
    return { handled: true, newMode: 'gazelle' };
  }

  if (input === ':coder') {
    if (c.mode === 'coder') {
      c.display.warning('Already in coder mode.');
      return { handled: true };
    }
    return { handled: true, newMode: 'coder' };
  }

  return null;
}

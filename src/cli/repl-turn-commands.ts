/**
 * REPL commands that manage the per-task turn limit:
 * :turnsoff / :turnson / :turns [n|off|on]
 */

import { DEFAULT_MAX_TURNS } from '../agent/loop-profile.js';
import type { Display } from './display.js';
import type { ReplCommandResult } from './repl-session-commands.js';

export interface TurnCommandCtx {
  turnsOverride?: number | undefined;
  defaultMaxTurns?: number;
  display: Pick<Display, 'success' | 'warning'>;
}

/**
 * Handles turn cap toggle/inspection commands:
 * - :turnsoff / /turnsoff / :turns off / :turn off -> Turn off the turn cap (unlimited)
 * - :turnson / /turnson / :turns on / :turn on -> Turn on / restore turn cap
 * - :turns <number> -> Set custom turn cap for this session (0 = off)
 * - :turns -> Show current turn cap status
 */
export function handleTurnCommand(
  input: string,
  c: TurnCommandCtx,
): ReplCommandResult | null {
  const norm = input.trim();

  // Turn cap OFF: :turnsoff, /turnsoff, :turns off, /turns off, :turn off, /turn off, :noturns
  if (
    norm === ':turnsoff' ||
    norm === '/turnsoff' ||
    norm === ':turns off' ||
    norm === '/turns off' ||
    norm === ':turn off' ||
    norm === '/turn off' ||
    norm === ':noturns'
  ) {
    c.display.success('Turn limit: OFF for this session (unlimited turns per task). Use :turnson to restore the cap.');
    return { handled: true, newTurnsOverride: Infinity };
  }

  // Turn cap ON: :turnson, /turnson, :turns on, /turns on, :turn on, /turn on
  if (
    norm === ':turnson' ||
    norm === '/turnson' ||
    norm === ':turns on' ||
    norm === '/turns on' ||
    norm === ':turn on' ||
    norm === '/turn on'
  ) {
    const target = c.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
    c.display.success(`Turn limit: ON (${target} turns cap per task).`);
    return { handled: true, newTurnsOverride: target };
  }

  // Set / inspect with arguments: :turns <arg> or /turns <arg>
  if (norm.startsWith(':turns ') || norm.startsWith('/turns ') || norm.startsWith(':turn ') || norm.startsWith('/turn ')) {
    const spaceIdx = norm.indexOf(' ');
    const arg = norm.slice(spaceIdx + 1).trim();
    if (arg === 'off' || arg === 'false' || arg === 'none') {
      c.display.success('Turn limit: OFF for this session (unlimited turns per task). Use :turnson to restore the cap.');
      return { handled: true, newTurnsOverride: Infinity };
    }
    if (arg === 'on' || arg === 'true') {
      const target = c.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
      c.display.success(`Turn limit: ON (${target} turns cap per task).`);
      return { handled: true, newTurnsOverride: target };
    }
    const n = Number(arg);
    if (!Number.isFinite(n) || n < 0) {
      c.display.warning(`Invalid turn limit "${arg}". Expected a positive number, "off", or "on".`);
      return { handled: true };
    }
    if (n === 0) {
      c.display.success('Turn limit: OFF for this session (unlimited turns per task). Use :turnson to restore the cap.');
      return { handled: true, newTurnsOverride: Infinity };
    }
    c.display.success(`Turn limit set to ${n} turns per task for this session.`);
    return { handled: true, newTurnsOverride: n };
  }

  // Status check: :turns or /turns or :turn or /turn
  if (norm === ':turns' || norm === '/turns' || norm === ':turn' || norm === '/turn') {
    const current = c.turnsOverride;
    if (current === Infinity || current === 0) {
      c.display.success('Turn limit: OFF (unlimited turns per task).');
    } else if (typeof current === 'number') {
      c.display.success(`Turn limit: ${current} turns per task (session override).`);
    } else {
      const target = c.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
      c.display.success(`Turn limit: ${target} turns per task (default).`);
    }
    return { handled: true };
  }

  return null;
}

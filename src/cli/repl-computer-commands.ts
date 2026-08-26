/**
 * REPL commands that turn computer use on and off mid-session:
 * :compon / :compoff / :comp.
 *
 * Why a toggle exists at all. The gate wants two independent keys — the
 * --computer flag and AURA_COMPUTER_USE=1 — so that neither a flag copied off
 * a forum post nor an env var exported once in a shell profile can switch on
 * screen capture and input injection by itself. That reasoning is sound, and
 * it is unchanged here. What it did not account for is the recovery path: with
 * both keys checked only at startup, someone who had one of them ended up
 * having to kill the session, fix their shell, and start over — losing the
 * conversation to a settings change. Worse, the tool's refusals told the model
 * to ask the user to "restart with that flag", so the advice the user got was
 * to throw the session away.
 *
 * `:compon` is a third key of the same strength, not a bypass. It is typed by
 * the human at the keyboard, in an interactive session, and it still shows the
 * full disclosure and waits for an explicit y/N the first time. That is more
 * evidence of intent than either startup key carries, not less.
 *
 * What must stay true: the *model* can never reach this. Tool calls cannot
 * produce REPL input, and mid-run steering only queues lines that do not start
 * with ':' (see agent/steering.ts), so there is no path from model output to
 * this handler. Only a keystroke gets here.
 */

import chalk from 'chalk';
import {
  setComputerUseEnabled, closeComputer, isComputerUseEnabled, isComputerSessionLive,
} from '../tools/computer.js';
import {
  COMPUTER_USE_ENV, COMPUTER_USE_DISCLOSURE, isAcknowledged, acknowledge,
} from '../tools/screen/disclosure.js';
import type { Display } from './display.js';
import type { ReplCommandResult } from './repl-session-commands.js';

export interface ComputerCommandCtx {
  display: Pick<Display, 'success' | 'warning'>;
  /** Consent prompt. The REPL passes the TUI-safe one; off-terminal callers
   *  that cannot ask must pass a function returning false, never one that
   *  returns true — silent consent is the one answer this must not invent. */
  confirm: (message: string) => Promise<boolean>;
  /** Prints a block of text. Separate from display because the disclosure is
   *  multi-line prose, not a status line. */
  write: (text: string) => void;
}

const ON  = [':compon', '/compon', ':comp on', '/comp on', ':computer on', '/computer on'];
const OFF = [':compoff', '/compoff', ':comp off', '/comp off', ':computer off', '/computer off'];
const STATUS = [':comp', '/comp', ':computer', '/computer', ':comp status', ':computer status'];

/** True when the env half of the gate reads as on. Mirrors checkComputerUseGate's
 *  parsing so status never disagrees with the gate that actually decides. */
function envEnabled(): boolean {
  const raw = (process.env[COMPUTER_USE_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function statusLines(): string[] {
  const on = isComputerUseEnabled() && envEnabled() && isAcknowledged();
  const live = isComputerSessionLive();
  return [
    '',
    on
      ? chalk.hex('#5a9e6e')('  Computer use: ON') + chalk.hex('#8a94a6')(
          live ? '  (sidecar running — holding the input device)' : '  (no sidecar yet — starts on first action)')
      : chalk.hex('#8a94a6')('  Computer use: OFF'),
    chalk.hex('#4a5568')(`    flag           ${isComputerUseEnabled() ? 'set' : 'not set'}`),
    chalk.hex('#4a5568')(`    ${COMPUTER_USE_ENV.padEnd(15)}${envEnabled() ? 'set' : 'not set'}`),
    chalk.hex('#4a5568')(`    disclosure     ${isAcknowledged() ? 'accepted on this machine' : 'not yet accepted'}`),
    '',
    chalk.hex('#4a5568')('    :compon to enable · :compoff to disable and release the device'),
    '',
  ];
}

export async function handleComputerCommand(
  input: string,
  c: ComputerCommandCtx,
): Promise<ReplCommandResult | null> {
  const norm = input.trim().toLowerCase().replace(/\s+/g, ' ');

  if (ON.includes(norm)) {
    if (isComputerUseEnabled() && envEnabled() && isAcknowledged()) {
      c.display.success('Computer use is already on. :comp for details, :compoff to turn it off.');
      return { handled: true };
    }

    // First time on this machine: the disclosure is the point of the command,
    // not a formality around it. Shown in full, and a bare Enter means no.
    if (!isAcknowledged()) {
      c.write(COMPUTER_USE_DISCLOSURE);
      const ok = await c.confirm('Enable computer use — screen capture and real mouse/keyboard control?');
      if (!ok) {
        c.display.warning('Computer use stays off. Nothing was enabled.');
        return { handled: true, newComputerUse: false };
      }
      acknowledge();
    }

    // Both halves of the gate, set together. Setting only one would reproduce
    // exactly the half-configured state this command exists to rescue people
    // from — and the env var is what the tool's own gate reads, so a child
    // process inheriting this environment sees the same answer.
    process.env[COMPUTER_USE_ENV] = '1';
    setComputerUseEnabled(true);

    c.display.success(
      'Computer use ON. Aura can see your screen and drive the pointer and keyboard. '
      + ':compoff turns it off and releases the device; :stop aborts a running task.',
    );
    // The single most confusing thing about the first run, and it is not
    // Aura's dialog to raise or dismiss: the desktop portal asks for screen
    // sharing on the first capture, and it can open behind whatever is
    // focused. Missed, it looks like Aura hanging — the capture then waits out
    // a two-minute portal timeout before failing. Cheaper to say so now.
    if (process.platform === 'linux') {
      c.display.warning(
        'First screen action will raise your desktop\'s screen-sharing dialog — approve it. '
        + 'It can open behind other windows; if nothing seems to happen, go look for it.',
      );
    }
    return { handled: true, newComputerUse: true };
  }

  if (OFF.includes(norm)) {
    const wasLive = isComputerSessionLive();
    // Order matters: drop the flag first, so a tool call racing this command
    // is refused by the gate rather than restarting the sidecar we are closing.
    setComputerUseEnabled(false);
    delete process.env[COMPUTER_USE_ENV];
    await closeComputer();

    c.display.success(
      wasLive
        ? 'Computer use OFF — sidecar stopped, input device and portal session released.'
        : 'Computer use OFF.',
    );
    return { handled: true, newComputerUse: false };
  }

  if (STATUS.includes(norm)) {
    for (const line of statusLines()) c.write(line);
    return { handled: true };
  }

  return null;
}

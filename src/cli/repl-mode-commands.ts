/**
 * The REPL's two mode commands: :coder and :gazelle.
 *
 * These lived only in the --gazelle orchestrator's loops, so typing them into
 * the ordinary REPL sent them to the model as a task — while :help listed them
 * at the top of its "Modes" section. They sit in their own module for the same
 * reason repl-session-commands.ts does: cli/index.ts self-executes on import
 * (it reads real credentials into process.env at module scope), so a branch
 * that lives there cannot be covered by a test, which is how a command can be
 * advertised and unimplemented at the same time without anything going red.
 *
 * The switch itself stays in index.ts — the mode variable and the live Gazelle
 * chat belong to the interactive session's scope — so this only reports intent.
 */

import type { Display } from './display.js';
import type { ReplCommandResult, ReplMode } from './repl-session-commands.js';

/** The slice of ReplCtx these commands touch. Declared structurally rather
 *  than importing ReplCtx so this module never depends on index.ts. */
export interface ModeCommandCtx {
  mode: ReplMode;
  display: Pick<Display, 'warning'>;
}

/**
 * Returns a result when `input` is a mode command, or null to let the caller's
 * remaining branches try it.
 */
export function handleModeCommand(input: string, c: ModeCommandCtx): ReplCommandResult | null {
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

/**
 * The REPL's Archimedes routing commands: :small1, :archon, :archoff and
 * :archmodel.
 *
 * These five branches are what let a session override the competence gate and
 * the alternator without editing .aura.json, so each one's contract is "report
 * a new override value back to the REPL loop". That makes them a coherent unit
 * and — unlike most of handleReplCommand — a purely functional one: they read
 * episode stats and return flags, they never touch the loop's own state.
 *
 * They sit in their own module for the same reason repl-session-commands.ts
 * does: cli/index.ts self-executes on import (it reads real credentials into
 * process.env at module scope), so a branch that lives there cannot be covered
 * by a test. An override that silently stopped being returned would look
 * exactly like a working command from the outside.
 */

import type { Display } from './display.js';
import type { ReplCommandResult } from './repl-session-commands.js';

/** The slice of ReplCtx these commands touch. Declared structurally rather
 *  than importing ReplCtx so this module never depends on index.ts. */
export interface ArchimedesCommandCtx {
  /** Project root — episode stats are per-project. */
  projectRoot: string;
  /** Current :archmodel value, or undefined when none has been set. */
  archimedesModelOverride: string | undefined;
  display: Pick<Display, 'success' | 'warning'>;
}

/**
 * Returns a result when `input` is one of these commands, or null to let the
 * caller's remaining branches try it. The caller must invoke this at the same
 * point in its if-chain that these branches previously occupied — calling it
 * earlier would let these commands shadow ones declared above them.
 */
export async function handleArchimedesCommand(
  input: string,
  c: ArchimedesCommandCtx,
): Promise<ReplCommandResult | null> {
  if (input === ':small1' || input === ':small1 on') {
    const { getEpisodeStats } = await import('../archimedes/index.js');
    const stats = await getEpisodeStats(c.projectRoot);
    const attempts = stats.archimedesSuccesses + stats.archimedesFailures;
    const score = attempts > 0
      ? `${Math.round((stats.archimedesSuccesses / attempts) * 100)}% over ${attempts} attempt(s)`
      : 'no recorded attempts yet';
    c.display.success(
      `Starting with Archimedes (small1 override — competence gate bypassed, current score: ${score}). ` +
      `Verification and escalation still apply; attempts update the score normally. :small1 off to revert.`,
    );
    return { handled: true, newSmall1Override: true };
  }

  if (input === ':small1 off') {
    c.display.success('small1 override: OFF — normal Archimedes competence routing restored.');
    return { handled: true, newSmall1Override: false };
  }

  if (input === ':archon') {
    c.display.success('Archimedes Alternator: ON for this session (overrides .aura.json until :archoff or restart).');
    return { handled: true, newArchimedesOverride: true };
  }

  if (input === ':archoff') {
    c.display.success('Archimedes Alternator: OFF for this session (overrides .aura.json until :archon or restart).');
    return { handled: true, newArchimedesOverride: false };
  }

  if (input.startsWith(':archmodel ')) {
    const modelTag = input.slice(':archmodel '.length).trim();
    if (!modelTag) {
      c.display.warning(
        'Usage: :archmodel <model>  e.g. :archmodel qwen3-vl:4b (Ollama) ' +
        'or :archmodel lmstudio/qwen/qwen3-1.7b (LM Studio)',
      );
      return { handled: true };
    }
    return { handled: true, newArchimedesModelOverride: modelTag };
  }

  if (input === ':archmodel') {
    const current = c.archimedesModelOverride ?? '(from .aura.json or auto-detect)';
    c.display.success(`Archimedes model: ${current}`);
    return { handled: true };
  }

  return null;
}

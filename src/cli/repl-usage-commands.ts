/**
 * The REPL's usage-reporting commands: /clear, /stats, /context and /cost.
 *
 * What makes these one unit is that every one of them only *reads or resets
 * the counters* — none of them changes what the next turn actually sends. That
 * distinction is the whole reason /clear prints its second line: "reset" and
 * "clear" read as "start fresh", and a user who believes that keeps paying to
 * resend a history that was never dropped. Keeping these four together makes
 * the boundary against :new / :clear-history (repl-session-commands.ts, which
 * really does drop history) explicit rather than incidental.
 *
 * /context tune stays in index.ts: it drives the shared readline through the
 * fullscreen-prompt handoff, which is REPL-loop state, not a counter.
 *
 * They sit in their own module for the same reason repl-session-commands.ts
 * does: cli/index.ts self-executes on import (it reads real credentials into
 * process.env at module scope), so a branch that lives there cannot be covered
 * by a test.
 */

import chalk from 'chalk';
import { TEXT_DIM_HEX } from './diamond.js';
import type { ContextHealthTracker } from './context-health.js';
import type { Display } from './display.js';
import type { ReplCommandResult } from './repl-session-commands.js';

/** The REPL's running per-session totals, as displayed by /stats. */
export interface SessionCounters {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The slice of ReplCtx these commands touch. Declared structurally rather
 *  than importing ReplCtx so this module never depends on index.ts. */
export interface UsageCommandCtx {
  /** Project root — the token log /cost reads is per-project. */
  projectRoot: string;
  cumulative: SessionCounters;
  healthTracker: ContextHealthTracker;
  display: Pick<Display, 'contextDashboard'>;
}

/**
 * Returns a result when `input` is one of these commands, or null to let the
 * caller's remaining branches try it. The caller must invoke this at the same
 * point in its if-chain that these branches previously occupied — calling it
 * earlier would let these commands shadow ones declared above them, and in
 * particular this must run *before* the /context tune branch only if that
 * branch's exact-match forms stay distinct from '/context'.
 */
export async function handleUsageCommand(
  input: string,
  c: UsageCommandCtx,
): Promise<ReplCommandResult | null> {
  if (input === '/clear' || input === '/reset') {
    c.cumulative.turns = 0;
    c.cumulative.toolCalls = 0;
    c.cumulative.inputTokens = 0;
    c.cumulative.outputTokens = 0;
    c.cumulative.costUsd = 0;
    console.log(chalk.hex('#5a9e6e')('  ✓ Session stats reset'));
    // This zeroes the *displayed* counters only — the underlying history
    // (what actually gets resent and billed on the next task) is untouched.
    // Say so explicitly: "reset"/"clear" reads as "start fresh" otherwise,
    // and a user who believes that will keep paying to resend everything.
    console.log(chalk.hex(TEXT_DIM_HEX)('    (conversation history is unchanged — use :new or :clear-history to actually reset it)'));
    return { handled: true };
  }

  if (input === '/stats' || input === '/usage') {
    const u = c.cumulative;
    const total = u.inputTokens + u.outputTokens;
    console.log(chalk.hex(TEXT_DIM_HEX)([
      '',
      `  Session usage:`,
      `    Turns:        ${u.turns}`,
      `    Tool calls:   ${u.toolCalls}`,
      `    Input tokens: ${u.inputTokens.toLocaleString()}`,
      `    Output tokens:${u.outputTokens.toLocaleString()}`,
      `    Total tokens: ${total.toLocaleString()}`,
      `    Est. cost:    ${u.costUsd.toFixed(4)}`,
      '',
    ].join('\n')));
    return { handled: true };
  }

  if (input === '/context') {
    const u = c.cumulative;
    const h = c.healthTracker.snapshot(u.inputTokens, u.outputTokens);
    h.turnCount = u.turns;
    h.toolCallCount = u.toolCalls;
    c.display.contextDashboard?.(h);
    return { handled: true };
  }

  if (input === '/cost' || input.startsWith('/cost ')) {
    const { readTokenLog, formatCostReport } = await import('./cost-report.js');
    const arg = input.startsWith('/cost ') ? input.slice('/cost '.length).trim() : '';
    const recent = /^\d+$/.test(arg) ? Number(arg) : 20;
    console.log(formatCostReport(readTokenLog(c.projectRoot), recent));
    return { handled: true };
  }

  return null;
}

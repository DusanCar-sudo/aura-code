/**
 * REPL command for the cost ledger: `:cost`.
 *
 * The Archimedes path makes an economic claim — small model first, escalate
 * only when needed, cheaper than always direct. This command reads the ledger
 * the alternator appends to (~/.aura/cost-log/<date>.jsonl) and reports
 * whether the claim holds in measurement:
 *
 *   - total tokens actually spent
 *   - counterfactual: what those tasks would have cost going direct-large
 *   - net saving/loss, absolute and percent
 *   - the same three numbers per outcome bucket
 *   - the gate's contribution alone (tokens never spent because of gating)
 *
 * Aggregation is pure (cost-log.ts) so the math is testable; this module only
 * loads rows and renders them.
 */

import chalk from 'chalk';
import { aggregateCosts, defaultCostLogDir, loadCostLogs, type CostOutcome } from '../archimedes/cost-log.js';
import type { ReplCommandResult } from './repl-session-commands.js';

const DIM = '#8a94a6';
const FAINT = '#4a5568';
const ACCENT = '#cc785c';
const GOOD = '#5a9e6e';
const BAD = '#b15439';

/** Shorthand names for the outcome buckets in the report. */
const OUTCOME_LABELS: Record<CostOutcome, string> = {
  gated: 'Gated (gate refused small model)',
  'small-success': 'Small success (no large run)',
  escalated: 'Escalated (small failed → large)',
  'direct-large': 'Direct large (no small attempt)',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtPercent(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmtTokens(n)}`;
}

function colorBySign(n: number): (text: string) => string {
  return n >= 0 ? chalk.hex(GOOD) : chalk.hex(BAD);
}

/**
 * Renders the :cost report to a list of lines. Pure — takes the ledger rows
 * (or the loaded entries) and returns text, so tests can assert on it without
 * a terminal.
 */
export function renderCostReport(entries: Awaited<ReturnType<typeof loadCostLogs>>): string[] {
  const r = aggregateCosts(entries);
  const lines: string[] = [];

  if (r.entries === 0) {
    lines.push(chalk.hex(DIM)('  No cost rows yet. Every Archimedes-path attempt appends one; run :cost after the alternator has worked.'));
    lines.push(chalk.hex(FAINT)(`  Ledger: ${defaultCostLogDir()}`));
    return lines;
  }

  lines.push(
    chalk.hex(ACCENT)(`  Cost ledger — ${r.entries} attempt(s) over ${r.days} day(s)`),
    chalk.hex(FAINT)(`  ${defaultCostLogDir()}`),
    '',
  );

  // ── Totals ────────────────────────────────────────────────────────────────
  lines.push(chalk.hex(DIM)('  ── Total ─────────────────────────────────────────────────'));
  lines.push(
    `  Actually spent:    ${chalk.hex('#d8dee9')(fmtTokens(r.actualTokens))} tokens`,
    `  Direct-large view: ${fmtTokens(r.directLargeTokens)} tokens (${r.directLargeMeasured} measured, ${r.directLargeEstimated} estimated)`,
  );
  lines.push(
    `  Net ${r.netTokens >= 0 ? 'saving' : 'loss'}:      ` +
    colorBySign(r.netTokens)(`${fmtSigned(r.netTokens)} (${fmtPercent(r.netPercent)})`),
  );
  // A large-model call that reported zero tokens never billed — a provider
  // error, an exhausted balance, a refusal. Those rows carry no counterfactual,
  // so if they dominate the ledger the net figure above means nothing and must
  // not be read as a result.
  if (r.unbilledLargeCalls > 0) {
    const share = r.entries > 0 ? (r.unbilledLargeCalls / r.entries) * 100 : 0;
    const warn = share >= 50 ? chalk.hex('#ebcb8b') : chalk.hex(FAINT);
    lines.push(warn(
      `  ⚠ ${r.unbilledLargeCalls} of ${r.entries} row(s) recorded a large-model call that billed `
      + `0 tokens (${share.toFixed(0)}%).`,
    ));
    if (r.directLargeMeasured === 0) {
      lines.push(warn(
        '    Nothing was ever billed, so there is no counterfactual — the net figure above is not a result.',
      ));
    }
  }
  lines.push('');
  lines.push(
    chalk.hex(DIM)('  Gate contribution (tokens never spent because of gating): ') +
    colorBySign(r.gateContribution)(`${fmtTokens(r.gateContribution)}`) +
    chalk.hex(FAINT)(`  across ${r.gateContributionRows} gated row(s), based on ${r.gateContributionBasis} measured attempt(s)`),
  );
  lines.push('');

  // ── By outcome ────────────────────────────────────────────────────────────
  lines.push(chalk.hex(DIM)('  ── By outcome ───────────────────────────────────────────'));
  for (const out of ['gated', 'small-success', 'escalated', 'direct-large'] as CostOutcome[]) {
    const b = r.byOutcome[out];
    if (b.attempts === 0) {
      lines.push(chalk.hex(FAINT)(`  ${OUTCOME_LABELS[out].padEnd(42)} —`));
      continue;
    }
    lines.push(
      `  ${OUTCOME_LABELS[out].padEnd(42)} ${String(b.attempts).padStart(3)}  ` +
      `spent ${fmtTokens(b.actualTokens).padStart(7)}  ` +
      `direct ${fmtTokens(b.directLargeTokens).padStart(7)}  ` +
      colorBySign(b.netTokens)(fmtSigned(b.netTokens)) +
      ` (${fmtPercent(b.netPercent)})`,
    );
  }
  lines.push('');

  // ── Caveat ────────────────────────────────────────────────────────────────
  lines.push(chalk.hex(FAINT)(
    '  Small-success counterfactuals are estimated from the per-category average of measured',
  ));
  lines.push(chalk.hex(FAINT)(
    '  large-model runs when the large model never ran for that task. Gate contribution is',
  ));
  lines.push(chalk.hex(FAINT)(
    '  similarly estimated from measured attempts (the epsilon probe keeps it measurable).',
  ));

  return lines;
}

/** `:cost` handler — async like the other handlers that read state. */
export async function handleCostCommand(input: string): Promise<ReplCommandResult | null> {
  const lower = input.trim().toLowerCase();
  if (lower !== ':cost' && !lower.startsWith(':cost ')) return null;
  const entries = await loadCostLogs();
  for (const line of renderCostReport(entries)) console.log(line);
  return { handled: true };
}

/**
 * Cost report over .aura/token-log.jsonl (written per provider call by
 * loop.ts:logTokenUsage).
 *
 * Exists because cache hit ratio is the dominant cost lever and was
 * previously invisible at runtime: an investigated session carried 7.75M
 * tokens uncached at $7.90, then 19.5M tokens at 98% cached for $1.04 — same
 * work, 7.6x cheaper — and nothing in the CLI surfaced that difference while
 * it was happening.
 *
 * Parsing is deliberately tolerant: a truncated final line (killed mid-write)
 * or a field added by a newer version must not break the report.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { TEXT_DIM_HEX, FAINT_HEX } from './diamond.js';
import type { TokenLogEntry } from '../agent/loop.js';

export interface CostSummary {
  calls: number;
  input: number;
  output: number;
  cacheHit: number;
  costUsd: number;
  /** Share of input tokens served from cache, across every call. */
  hitRatio: number;
  /** What the same input would have cost with a 0% hit rate, minus actual. */
  savedUsd: number;
  byModel: Map<string, { calls: number; input: number; cacheHit: number; costUsd: number }>;
}

export function tokenLogPath(root: string): string {
  return path.join(root, '.aura', 'token-log.jsonl');
}

/** Read the log, newest last. Returns [] when absent or unreadable. */
export function readTokenLog(root: string, limit?: number): TokenLogEntry[] {
  const file = tokenLogPath(root);
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }

  const entries: TokenLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TokenLogEntry;
      if (typeof e.input === 'number' && typeof e.costUsd === 'number') entries.push(e);
    } catch { /* skip a partial/corrupt line rather than failing the report */ }
  }
  return limit !== undefined ? entries.slice(-limit) : entries;
}

export function summarize(entries: TokenLogEntry[]): CostSummary {
  const byModel = new Map<string, { calls: number; input: number; cacheHit: number; costUsd: number }>();
  let input = 0, output = 0, cacheHit = 0, costUsd = 0;

  for (const e of entries) {
    input += e.input; output += e.output;
    cacheHit += e.cacheHit ?? 0; costUsd += e.costUsd;
    const m = byModel.get(e.model) ?? { calls: 0, input: 0, cacheHit: 0, costUsd: 0 };
    m.calls++; m.input += e.input; m.cacheHit += e.cacheHit ?? 0; m.costUsd += e.costUsd;
    byModel.set(e.model, m);
  }

  // Cached input bills at ~1/10 the normal rate across the providers Aura
  // routes to, so the uncached counterfactual is the cached share priced back
  // up ~9x its discounted cost. Approximate by design — it is a signal about
  // whether caching is working, not an invoice.
  const cachedCostShare = input > 0 ? (cacheHit / input) * costUsd : 0;
  const savedUsd = cachedCostShare * 9;

  return {
    calls: entries.length, input, output, cacheHit, costUsd,
    hitRatio: input > 0 ? cacheHit / input : 0,
    savedUsd, byModel,
  };
}

function bar(ratio: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const colour = ratio >= 0.7 ? '#5a9e6e' : ratio >= 0.3 ? '#d4903a' : '#b15439';
  return chalk.hex(colour)('█'.repeat(filled)) + chalk.hex(FAINT_HEX)('░'.repeat(width - filled));
}

const k = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

/** Render the report. `recent` controls how many per-call rows are listed. */
export function formatCostReport(entries: TokenLogEntry[], recent = 20): string {
  if (entries.length === 0) {
    return chalk.hex(TEXT_DIM_HEX)(
      '\n  No token log yet — .aura/token-log.jsonl is written as calls happen.\n',
    );
  }

  const s = summarize(entries);
  const w = process.stdout.columns ?? 80;
  const line = '─'.repeat(Math.min(w - 4, 68));
  const out: string[] = ['', chalk.hex(FAINT_HEX)(line), chalk.hex('#cc785c').bold('  Cost & cache report'), chalk.hex(FAINT_HEX)(line), ''];

  out.push(
    '  Calls:      ' + chalk.hex('#c8b5a0')(String(s.calls)),
    '  Input:      ' + chalk.hex('#c8b5a0')(s.input.toLocaleString()) + ' tokens',
    '  Output:     ' + chalk.hex('#c8b5a0')(s.output.toLocaleString()) + ' tokens',
    '  Cost:       ' + chalk.hex('#c8b5a0')('$' + s.costUsd.toFixed(4)),
    '',
    '  Cache hit:  ' + bar(s.hitRatio) + ' ' + chalk.bold((s.hitRatio * 100).toFixed(1) + '%')
      + chalk.hex(TEXT_DIM_HEX)(`  (${s.cacheHit.toLocaleString()} of ${s.input.toLocaleString()} input tokens)`),
  );

  if (s.hitRatio < 0.3 && s.input > 50_000) {
    out.push('', chalk.hex('#d4903a')('  ⚠  Low cache hit rate on a large session.'));
    out.push(chalk.hex(TEXT_DIM_HEX)('     Input is being re-sent uncached each turn. Common causes: a system'));
    out.push(chalk.hex(TEXT_DIM_HEX)('     prompt that changes between calls, or a provider that does not cache.'));
  } else if (s.hitRatio >= 0.7) {
    out.push('', chalk.hex('#5a9e6e')(`  ✓ Caching is working — roughly $${s.savedUsd.toFixed(2)} avoided at this hit rate.`));
  }

  if (s.byModel.size > 1) {
    out.push('', chalk.hex('#cc785c').bold('  By model'));
    for (const [model, m] of [...s.byModel].sort((a, b) => b[1].costUsd - a[1].costUsd)) {
      const r = m.input > 0 ? m.cacheHit / m.input : 0;
      out.push(
        '    ' + chalk.hex('#c8b5a0')(model.padEnd(28).slice(0, 28))
        + chalk.hex(TEXT_DIM_HEX)(String(m.calls).padStart(4) + ' calls  ')
        + chalk.hex(TEXT_DIM_HEX)(k(m.input).padStart(7) + ' in  ')
        + chalk.hex(TEXT_DIM_HEX)((r * 100).toFixed(0).padStart(3) + '% cached  ')
        + chalk.hex('#d4903a')('$' + m.costUsd.toFixed(4)),
      );
    }
  }

  const tail = entries.slice(-recent);
  out.push('', chalk.hex('#cc785c').bold(`  Last ${tail.length} call(s)`));
  out.push(chalk.hex(FAINT_HEX)('    turn      input   cached    cost'));
  for (const e of tail) {
    const r = e.input > 0 ? (e.cacheHit ?? 0) / e.input : 0;
    const colour = r >= 0.7 ? '#5a9e6e' : r >= 0.3 ? '#d4903a' : '#b15439';
    out.push(
      '    ' + chalk.hex(FAINT_HEX)(String(e.turn).padStart(4))
      + chalk.hex('#c8b5a0')(k(e.input).padStart(11))
      + chalk.hex(colour)(((r * 100).toFixed(0) + '%').padStart(9))
      + chalk.hex(TEXT_DIM_HEX)(('$' + e.costUsd.toFixed(4)).padStart(10)),
    );
  }

  // Most expensive cold-cache calls: where the money actually went.
  const cold = [...entries].filter(e => (e.input > 0 ? (e.cacheHit ?? 0) / e.input : 0) < 0.3)
    .sort((a, b) => b.costUsd - a.costUsd).slice(0, 3);
  if (cold.length > 0 && s.hitRatio < 0.9) {
    out.push('', chalk.hex('#cc785c').bold('  Most expensive uncached calls'));
    for (const e of cold) {
      out.push('    ' + chalk.hex(FAINT_HEX)(`turn ${e.turn}`.padEnd(10))
        + chalk.hex('#c8b5a0')(k(e.input).padStart(8) + ' in')
        + chalk.hex('#b15439')(('$' + e.costUsd.toFixed(4)).padStart(10))
        + chalk.hex(TEXT_DIM_HEX)('  ' + e.model));
    }
  }

  out.push('', chalk.hex(FAINT_HEX)(line), '');
  return out.join('\n');
}

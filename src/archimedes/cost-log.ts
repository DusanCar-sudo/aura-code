import * as fs from 'fs';
import * as path from 'path';
import type { TaskCategory } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cost log — one JSONL row per Archimedes-path attempt, ~/.aura/cost-log/
//
// The Archimedes gate is an economic claim: "small model first, escalate only
// when needed, and the whole thing nets cheaper than always going direct to
// the large model." Until this file existed, that claim could only be argued
// from design. Every alternation attempt appends one row here with what each
// tier actually consumed, and `:cost` aggregates the rows to show whether the
// claim holds in measurement.
//
// Deliberately separate from the episode store (~/.aura/episodes): episodes
// are per-project training data, cost rows are a global ledger. One row per
// attempt, never a running total — the ledger must stay append-only so the
// aggregation can always be recomputed from raw facts.
//
// Token source: the same numbers the live session uses — real per-API-call
// usage reported by the provider (LoopResult.usage / LLMResponse.usage), with
// countText as the fallback estimator when a provider omits usage. No second
// estimator is invented here.
// ─────────────────────────────────────────────────────────────────────────────

/** What actually happened on one attempt. */
export type CostOutcome =
  /** The competence gate refused the small model; only the large model ran. */
  | 'gated'
  /** Small model handled the task and passed verification. */
  | 'small-success'
  /** Small model attempted but was rejected / failed; large model ran. */
  | 'escalated'
  /** No small attempt at all for infra reasons: Archimedes off or backend down. */
  | 'direct-large';

export interface CostModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** One row of the cost ledger. */
export interface CostLogEntry {
  /** Unix ms when the attempt completed. */
  timestamp: number;
  /** Task category the router assigned. */
  taskCategory: TaskCategory;
  /** Competence pattern key (category:slug) this attempt belongs to. */
  patternKey: string;
  outcome: CostOutcome;
  /** Small-model attempt usage, or null when no attempt happened. */
  smallModel: CostModelUsage | null;
  /** All verification calls' usage summed, or null when nothing was verified. */
  verifier: CostModelUsage | null;
  /** Large-model usage, or null when the large model never ran. */
  largeModel: CostModelUsage | null;
  /** Wall-clock duration of the attempt in ms. */
  wallMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Root of the cost ledger (tests inject their own dir).
 *  AURA_COST_LOG_DIR: harnesses (benchmark/escalation) isolate runs into a
 *  scratch dir so synthetic attempts never pollute the live ledger. */
export function defaultCostLogDir(): string {
  return process.env.AURA_COST_LOG_DIR
    ?? path.join(process.env.HOME ?? '/tmp', '.aura', 'cost-log');
}

export function dateStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Appends one row to today's ledger file (`<date>.jsonl`). Creates the
 * directory on first use. Appends only — historical files are never rewritten.
 */
export async function appendCostLog(
  entry: CostLogEntry,
  dir: string = defaultCostLogDir(),
): Promise<void> {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dateStamp(entry.timestamp)}.jsonl`);
  await fs.promises.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Loads every ledger row, oldest first. Skips corrupt lines rather than
 * failing the whole read — a torn write must not hide the other data.
 */
export async function loadCostLogs(dir: string = defaultCostLogDir()): Promise<CostLogEntry[]> {
  try {
    if (!fs.existsSync(dir)) return [];
    const files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.jsonl')).sort();
    const entries: CostLogEntry[] = [];
    for (const file of files) {
      const raw = await fs.promises.readFile(path.join(dir, file), 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed = JSON.parse(t) as CostLogEntry;
          if (parsed && typeof parsed.timestamp === 'number' && typeof parsed.outcome === 'string') {
            entries.push(parsed);
          }
        } catch {
          /* skip corrupt line */
        }
      }
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation (pure — no I/O, so the math is directly testable)
// ─────────────────────────────────────────────────────────────────────────────

export interface CostBucket {
  attempts: number;
  actualTokens: number;
  /** Counterfactual: what this bucket would have cost going direct-large. */
  directLargeTokens: number;
  /** directLarge − actual; positive = saved, negative = net loss. */
  netTokens: number;
  netPercent: number;
}

export interface CostReport {
  entries: number;
  /** Span of the log in calendar days (1 when there is data). */
  days: number;
  actualTokens: number;
  directLargeTokens: number;
  /** directLarge − actual; positive = saved. */
  netTokens: number;
  netPercent: number;
  /** How many rows' counterfactual is measured (large model actually ran). */
  directLargeMeasured: number;
  /** How many rows' counterfactual is estimated (small-success rows). */
  directLargeEstimated: number;
  /** Estimated tokens never spent because the gate refused the attempt. */
  gateContribution: number;
  /** Gated rows the contribution is summed over. */
  gateContributionRows: number;
  /**
   * Rows whose large-model call reported zero tokens — a failed or unbilled
   * call. High counts mean the ledger is recording attempts that never reached
   * a provider, and the net figure is close to meaningless until they are
   * explained.
   */
  unbilledLargeCalls: number;
  /** Measured attempts that informed the per-attempt average. */
  gateContributionBasis: number;
  byOutcome: Record<CostOutcome, CostBucket>;
}

function usageTokens(u: CostModelUsage | null): number {
  return u ? u.tokensIn + u.tokensOut : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Aggregates ledger rows into the `:cost` numbers.
 *
 * Semantics (each is honest about what is measured vs estimated):
 * - actualTokens: every token the attempts actually consumed (small + verifier
 *   + large), straight from the ledger.
 * - directLargeTokens (counterfactual): what each row would have cost had the
 *   task gone straight to the large model. Measured when the large model ran;
 *   for small-success rows — where the large model never ran — it is estimated
 *   from the per-category average of measured large-model costs, falling back
 *   to the global average when a category has no measurement. `directLarge*
 *   counts expose how much of the counterfactual is estimate.
 * - gateContribution: the gate's own value — the tokens NEVER spent because the
 *   gate refused the attempt. Estimated as the average measured attempt cost
 *   (small + verifier) in the row's category × gated rows; when no attempt in
 *   that category was ever measured, the global attempt average is used. This
 *   is what the epsilon probe exists to keep measurable.
 */
export function aggregateCosts(entries: CostLogEntry[]): CostReport {
  // Measured large-model costs per category (basis for the counterfactual).
  const largeByCat = new Map<TaskCategory, CostModelUsage[]>();
  const allLarge: CostModelUsage[] = [];
  for (const e of entries) {
    // A zero-token usage record is a call that never billed — a provider error,
    // an exhausted balance, a refusal. It is NOT a measurement that the large
    // model would have cost nothing, so it must not enter the counterfactual
    // basis. Counting it did: 30 rows against a lapsed DeepSeek account made
    // directLargeTokens 0 and reported the gate as a 100% loss.
    if (e.largeModel && usageTokens(e.largeModel) > 0) {
      allLarge.push(e.largeModel);
      const arr = largeByCat.get(e.taskCategory) ?? [];
      arr.push(e.largeModel);
      largeByCat.set(e.taskCategory, arr);
    }
  }
  const catLargeAvg = (cat: TaskCategory): number =>
    mean((largeByCat.get(cat) ?? []).map(u => u.tokensIn + u.tokensOut));
  const globalLargeAvg = mean(allLarge.map(u => u.tokensIn + u.tokensOut));

  // Measured attempt costs per category (small + verifier) — the gate's basis.
  const attemptByCat = new Map<TaskCategory, number[]>();
  const allAttempts: number[] = [];
  for (const e of entries) {
    if (e.smallModel && usageTokens(e.smallModel) > 0) {
      const cost = usageTokens(e.smallModel) + usageTokens(e.verifier);
      allAttempts.push(cost);
      const arr = attemptByCat.get(e.taskCategory) ?? [];
      arr.push(cost);
      attemptByCat.set(e.taskCategory, arr);
    }
  }
  const catAttemptAvg = (cat: TaskCategory): number => mean(attemptByCat.get(cat) ?? []);
  const globalAttemptAvg = mean(allAttempts);

  const emptyBucket = (): CostBucket => ({
    attempts: 0, actualTokens: 0, directLargeTokens: 0, netTokens: 0, netPercent: 0,
  });
  const byOutcome: Record<CostOutcome, CostBucket> = {
    gated: emptyBucket(),
    'small-success': emptyBucket(),
    escalated: emptyBucket(),
    'direct-large': emptyBucket(),
  };

  let actualTokens = 0;
  let directLargeTokens = 0;
  let directLargeMeasured = 0;
  let directLargeEstimated = 0;
  let gateContribution = 0;
  let gateContributionRows = 0;
  let unbilledLargeCalls = 0;

  for (const e of entries) {
    const actual = usageTokens(e.smallModel) + usageTokens(e.verifier) + usageTokens(e.largeModel);
    let direct: number;
    if (e.largeModel && usageTokens(e.largeModel) > 0) {
      direct = usageTokens(e.largeModel);
      directLargeMeasured++;
    } else {
      // Small-success (or a large path that produced no usage measurement):
      // estimate what a direct-large run would have cost in this category.
      const cat = catLargeAvg(e.taskCategory);
      direct = cat > 0 ? cat : globalLargeAvg;
      directLargeEstimated++;
    }
    if (e.largeModel && usageTokens(e.largeModel) === 0) unbilledLargeCalls++;
    actualTokens += actual;
    directLargeTokens += direct;

    const b = byOutcome[e.outcome];
    b.attempts++;
    b.actualTokens += actual;
    b.directLargeTokens += direct;

    if (e.outcome === 'gated') {
      const cat = catAttemptAvg(e.taskCategory);
      gateContribution += cat > 0 ? cat : globalAttemptAvg;
      gateContributionRows++;
    }
  }

  const netTokens = directLargeTokens - actualTokens;
  const netPercent = directLargeTokens > 0 ? (netTokens / directLargeTokens) * 100 : 0;
  for (const b of Object.values(byOutcome) as CostBucket[]) {
    b.netTokens = b.directLargeTokens - b.actualTokens;
    b.netPercent = b.directLargeTokens > 0 ? (b.netTokens / b.directLargeTokens) * 100 : 0;
  }

  const days = entries.length === 0
    ? 0
    : Math.floor(
        (Math.max(...entries.map(e => e.timestamp)) - Math.min(...entries.map(e => e.timestamp)))
        / DAY_MS,
      ) + 1;

  return {
    entries: entries.length,
    days,
    actualTokens,
    directLargeTokens,
    netTokens,
    netPercent,
    directLargeMeasured,
    directLargeEstimated,
    gateContribution,
    gateContributionRows,
    gateContributionBasis: allAttempts.length,
    unbilledLargeCalls,
    byOutcome,
  };
}

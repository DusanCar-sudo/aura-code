import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendCostLog, loadCostLogs, aggregateCosts,
  type CostLogEntry, type CostModelUsage,
} from '../../src/archimedes/cost-log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic rows for the aggregation math.
// ─────────────────────────────────────────────────────────────────────────────

function u(model: string, tokensIn: number, tokensOut: number): CostModelUsage {
  return { model, tokensIn, tokensOut };
}

const BASE_TS = 1_752_000_000_000;

function row(partial: Partial<CostLogEntry>): CostLogEntry {
  return {
    timestamp: BASE_TS,
    taskCategory: 'implementation',
    patternKey: 'implementation:test_task',
    outcome: 'escalated',
    smallModel: null,
    verifier: null,
    largeModel: null,
    wallMs: 1_000,
    ...partial,
  };
}

/** A small attempt that passes: small + verifier only. */
function smallSuccess(cat: CostLogEntry['taskCategory'] = 'implementation'): CostLogEntry {
  return row({
    taskCategory: cat,
    outcome: 'small-success',
    smallModel: u('qwen2.5-coder:1.5b', 2_000, 500),
    verifier: u('claude-sonnet-4-5', 1_000, 100),
  });
}

/** A small attempt that fails and escalates: small + verifier + large. */
function escalated(cat: CostLogEntry['taskCategory'] = 'implementation'): CostLogEntry {
  return row({
    taskCategory: cat,
    outcome: 'escalated',
    smallModel: u('qwen2.5-coder:1.5b', 2_000, 500),
    verifier: u('claude-sonnet-4-5', 1_000, 100),
    largeModel: u('claude-sonnet-4-5', 10_000, 2_000),
  });
}

/** The gate refused the small model: large ran direct. */
function gated(cat: CostLogEntry['taskCategory'] = 'implementation'): CostLogEntry {
  return row({
    taskCategory: cat,
    outcome: 'gated',
    largeModel: u('claude-sonnet-4-5', 12_000, 3_000),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('cost-log — append + load round trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cost-log-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSONL line per append, keyed by date', async () => {
    await appendCostLog(row({ timestamp: BASE_TS, outcome: 'gated' }), dir);
    await appendCostLog(row({ timestamp: BASE_TS + 60_000, outcome: 'escalated' }), dir);
    const entries = await loadCostLogs(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].outcome).toBe('gated');
    expect(entries[1].outcome).toBe('escalated');
    // Files are split by day.
    const files = fs.readdirSync(dir);
    expect(files.some(f => f.endsWith('.jsonl'))).toBe(true);
  });

  it('skips corrupt lines instead of failing the whole read', async () => {
    await appendCostLog(row({}), dir);
    const file = path.join(dir, `${new Date(BASE_TS).toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, '{not json}\n');
    const entries = await loadCostLogs(dir);
    expect(entries).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('aggregateCosts — totals', () => {
  it('sums small + verifier + large as actual tokens', () => {
    const r = aggregateCosts([smallSuccess(), escalated(), gated()]);
    // small: 2_000+500=2_500; verifier: 1_000+100=1_100 ×2 = 2_200;
    // large: 12_000 (gated) + 12_000 (escalated) = 24_000
    const expectedActual =
      (2_500 + 1_100) + (2_500 + 1_100 + 12_000) + 15_000;
    expect(r.actualTokens).toBe(expectedActual);
  });

  it('counterfactual uses measured large cost when the large model ran', () => {
    const r = aggregateCosts([escalated(), gated()]);
    // escalated large = 12_000; gated large = 15_000 — both measured.
    expect(r.directLargeTokens).toBe(27_000);
    expect(r.directLargeMeasured).toBe(2);
    expect(r.directLargeEstimated).toBe(0);
  });

  it('estimates counterfactual for small-success rows from category average', () => {
    // One measured large run in 'implementation' at 12_000 tokens.
    const r = aggregateCosts([smallSuccess('implementation'), escalated('implementation')]);
    expect(r.directLargeMeasured).toBe(1);
    expect(r.directLargeEstimated).toBe(1);
    // small-success row estimated at the category average = 12_000.
    expect(r.directLargeTokens).toBe(12_000 + 12_000);
  });

  it('falls back to the global average when the category has no measurement', () => {
    // 'review' has no measured large run; only 'implementation' does (12_000).
    const r = aggregateCosts([smallSuccess('review'), escalated('implementation')]);
    expect(r.directLargeTokens).toBe(12_000 + 12_000);
  });

  it('reports net saving or loss, absolute and percent', () => {
    // direct 24_000 vs actual (2_500 + 1_100) + (2_500 + 1_100 + 12_000) = 19_200
    const r = aggregateCosts([smallSuccess(), escalated()]);
    expect(r.netTokens).toBe(24_000 - 19_200);
    expect(r.netPercent).toBeCloseTo((r.netTokens / 24_000) * 100, 5);
  });

  it('handles an empty ledger without dividing by zero', () => {
    const r = aggregateCosts([]);
    expect(r.entries).toBe(0);
    expect(r.actualTokens).toBe(0);
    expect(r.directLargeTokens).toBe(0);
    expect(r.netPercent).toBe(0);
    expect(r.days).toBe(0);
  });
});

describe('aggregateCosts — by outcome bucket', () => {
  it('groups every row under its outcome and computes per-bucket numbers', () => {
    const r = aggregateCosts([
      smallSuccess('implementation'),
      escalated('implementation'),
      gated('implementation'),
      row({ outcome: 'direct-large', largeModel: u('claude-sonnet-4-5', 9_000, 1_000) }),
    ]);
    expect(r.byOutcome['small-success'].attempts).toBe(1);
    expect(r.byOutcome.escalated.attempts).toBe(1);
    expect(r.byOutcome.gated.attempts).toBe(1);
    expect(r.byOutcome['direct-large'].attempts).toBe(1);

    // small-success bucket: actual = small+verifier = 3_600; counterfactual =
    // category average large. Three measured large runs in 'implementation'
    // (12_000 escalated + 15_000 gated + 10_000 direct-large) → 12_333.33.
    expect(r.byOutcome['small-success'].actualTokens).toBe(3_600);
    expect(r.byOutcome['small-success'].directLargeTokens).toBeCloseTo(37_000 / 3, 3);
    expect(r.byOutcome['small-success'].netTokens).toBeCloseTo(37_000 / 3 - 3_600, 3);

    // escalated bucket: actual = small+verifier+large.
    expect(r.byOutcome.escalated.actualTokens).toBe(2_500 + 1_100 + 12_000);
    // gated bucket: actual = large only.
    expect(r.byOutcome.gated.actualTokens).toBe(15_000);
    // direct-large bucket: actual = large only.
    expect(r.byOutcome['direct-large'].actualTokens).toBe(10_000);

    // Buckets sum to the totals.
    const sumActual = Object.values(r.byOutcome).reduce((s, b) => s + b.actualTokens, 0);
    const sumDirect = Object.values(r.byOutcome).reduce((s, b) => s + b.directLargeTokens, 0);
    expect(sumActual).toBe(r.actualTokens);
    expect(sumDirect).toBe(r.directLargeTokens);
  });
});

describe('aggregateCosts — gate contribution', () => {
  it('estimates tokens the gate prevented from being spent', () => {
    // One measured escalation in 'implementation' gives an attempt average of
    // small+verifier = 3_600. One gated row in the same category inherits it.
    const r = aggregateCosts([escalated('implementation'), gated('implementation')]);
    expect(r.gateContributionRows).toBe(1);
    expect(r.gateContributionBasis).toBe(1);
    expect(r.gateContribution).toBeCloseTo(3_600, 5);
  });

  it('uses the global attempt average when a category has no measured attempt', () => {
    // Measured attempt only in 'implementation' (3_600); gated row in 'review'.
    const r = aggregateCosts([escalated('implementation'), gated('review')]);
    expect(r.gateContribution).toBeCloseTo(3_600, 5);
  });

  it('is zero when nothing was gated', () => {
    const r = aggregateCosts([smallSuccess(), escalated()]);
    expect(r.gateContribution).toBe(0);
    expect(r.gateContributionRows).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A zero-token large-model record is a call that never billed — a provider
// error, an exhausted balance, a refusal. Treating it as a measurement that
// "direct-large would have cost 0" makes the gate look like a total loss.
// Found live: 30 rows against a lapsed DeepSeek account reported net -100%.
// ─────────────────────────────────────────────────────────────────────────────
describe('unbilled large-model calls', () => {
  const base = {
    timestamp: Date.now(),
    taskCategory: 'implementation' as const,
    patternKey: 'implementation:x',
    wallMs: 1000,
  };

  it('does not treat a zero-token large call as a measured counterfactual', () => {
    const report = aggregateCosts([
      { ...base, outcome: 'escalated', smallModel: { model: 's', tokensIn: 100, tokensOut: 10 },
        verifier: null, largeModel: { model: 'l', tokensIn: 0, tokensOut: 0 } },
      { ...base, outcome: 'escalated', smallModel: { model: 's', tokensIn: 100, tokensOut: 10 },
        verifier: null, largeModel: { model: 'l', tokensIn: 4000, tokensOut: 400 } },
    ]);
    // Only the billed row is a measurement; the unbilled one is estimated from it.
    expect(report.directLargeMeasured).toBe(1);
    expect(report.directLargeEstimated).toBe(1);
    expect(report.unbilledLargeCalls).toBe(1);
  });

  it('counts unbilled calls so a meaningless net figure is visible as such', () => {
    const rows = Array.from({ length: 4 }, () => ({
      ...base, outcome: 'escalated' as const,
      smallModel: { model: 's', tokensIn: 100, tokensOut: 10 },
      verifier: null,
      largeModel: { model: 'l', tokensIn: 0, tokensOut: 0 },
    }));
    const report = aggregateCosts(rows);
    expect(report.unbilledLargeCalls).toBe(4);
    // Nothing was ever billed, so there is no counterfactual to compare against.
    expect(report.directLargeTokens).toBe(0);
    expect(report.directLargeMeasured).toBe(0);
  });
});

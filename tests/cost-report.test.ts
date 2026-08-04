import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTokenLog, summarize, formatCostReport, tokenLogPath } from '../src/cli/cost-report.js';
import type { TokenLogEntry } from '../src/agent/loop.js';

const entry = (o: Partial<TokenLogEntry> = {}): TokenLogEntry => ({
  turn: 1, ts: '2026-07-25T12:00:00.000Z', model: 'glm-5.2',
  input: 100_000, output: 200, cacheHit: 0, cacheWrite: 0,
  hitRatio: 0, costUsd: 0.1, ...o,
});

describe('readTokenLog', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cost-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns empty when the log does not exist', () => {
    expect(readTokenLog(dir)).toEqual([]);
  });

  it('reads entries oldest-first', () => {
    fs.mkdirSync(path.join(dir, '.aura'), { recursive: true });
    fs.writeFileSync(tokenLogPath(dir),
      [entry({ turn: 1 }), entry({ turn: 2 })].map(e => JSON.stringify(e)).join('\n') + '\n');
    expect(readTokenLog(dir).map(e => e.turn)).toEqual([1, 2]);
  });

  it('survives a truncated final line (process killed mid-write)', () => {
    fs.mkdirSync(path.join(dir, '.aura'), { recursive: true });
    fs.writeFileSync(tokenLogPath(dir),
      JSON.stringify(entry({ turn: 1 })) + '\n' + '{"turn":2,"inp');
    expect(readTokenLog(dir).map(e => e.turn)).toEqual([1]);
  });

  it('honours the limit by keeping the most recent entries', () => {
    fs.mkdirSync(path.join(dir, '.aura'), { recursive: true });
    fs.writeFileSync(tokenLogPath(dir),
      [1, 2, 3, 4, 5].map(t => JSON.stringify(entry({ turn: t }))).join('\n') + '\n');
    expect(readTokenLog(dir, 2).map(e => e.turn)).toEqual([4, 5]);
  });
});

describe('summarize', () => {
  it('computes the hit ratio across all input tokens, not per-call average', () => {
    // A tiny fully-cached call must not outweigh a huge uncached one.
    const s = summarize([
      entry({ input: 1_000, cacheHit: 1_000 }),
      entry({ input: 99_000, cacheHit: 0 }),
    ]);
    expect(s.input).toBe(100_000);
    expect(s.hitRatio).toBeCloseTo(0.01, 5);
  });

  it('aggregates per model', () => {
    const s = summarize([
      entry({ model: 'glm-5.2', costUsd: 1 }),
      entry({ model: 'deepseek-v4-pro', costUsd: 2 }),
      entry({ model: 'glm-5.2', costUsd: 3 }),
    ]);
    expect(s.byModel.get('glm-5.2')!.calls).toBe(2);
    expect(s.byModel.get('glm-5.2')!.costUsd).toBe(4);
    expect(s.byModel.get('deepseek-v4-pro')!.calls).toBe(1);
  });

  it('reports no savings at a 0% hit rate', () => {
    expect(summarize([entry({ cacheHit: 0 })]).savedUsd).toBe(0);
  });

  it('handles an empty log without dividing by zero', () => {
    const s = summarize([]);
    expect(s.hitRatio).toBe(0);
    expect(s.costUsd).toBe(0);
  });
});

describe('formatCostReport', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('explains itself when there is no log yet', () => {
    expect(strip(formatCostReport([]))).toContain('No token log yet');
  });

  it('warns on a low hit rate over a large session', () => {
    const out = strip(formatCostReport([entry({ input: 200_000, cacheHit: 0 })]));
    expect(out).toContain('Low cache hit rate');
  });

  it('does not warn on a small session with no cache hits', () => {
    // Short sessions legitimately have nothing to cache yet.
    const out = strip(formatCostReport([entry({ input: 500, cacheHit: 0 })]));
    expect(out).not.toContain('Low cache hit rate');
  });

  it('confirms when caching is working', () => {
    const out = strip(formatCostReport([entry({ input: 100_000, cacheHit: 98_000 })]));
    expect(out).toContain('Caching is working');
  });

  it('surfaces the most expensive uncached calls', () => {
    const out = strip(formatCostReport([
      entry({ turn: 1, input: 10_000, cacheHit: 0, costUsd: 0.01 }),
      entry({ turn: 2, input: 200_000, cacheHit: 0, costUsd: 5.0 }),
    ]));
    expect(out).toContain('Most expensive uncached calls');
    expect(out).toMatch(/turn 2\s+200\.0k in\s+\$5\.0000/);
  });
});

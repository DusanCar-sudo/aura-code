import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  handleUsageCommand,
  type SessionCounters,
  type UsageCommandCtx,
} from '../src/cli/repl-usage-commands.js';
import { ContextHealthTracker, type ContextHealth } from '../src/cli/context-health.js';

/**
 * The gap this closes: these branches lived in cli/index.ts, which self-executes
 * on import, so the one property that actually matters about /clear — that it
 * resets the *counters* and not the history — was asserted nowhere. Someone
 * "fixing" /clear to also drop history would break the documented split with
 * :new / :clear-history and nothing would go red.
 */

const PROJECT = '/fake/project';

const counters = (over: Partial<SessionCounters> = {}): SessionCounters => ({
  turns: 7, toolCalls: 12, inputTokens: 4000, outputTokens: 1500, costUsd: 0.1234, ...over,
});

function makeCtx(over: Partial<UsageCommandCtx> = {}): UsageCommandCtx & {
  dashboards: ContextHealth[];
} {
  const dashboards: ContextHealth[] = [];
  return {
    projectRoot: PROJECT,
    cumulative: counters(),
    healthTracker: new ContextHealthTracker(() => 'system', () => [], 'claude-sonnet-5', 'claude-sonnet-5'),
    display: { contextDashboard: (h: ContextHealth) => { dashboards.push(h); } },
    dashboards,
    ...over,
  };
}

describe('REPL usage commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const out = () => logSpy.mock.calls.map(c => String(c[0])).join('\n');

  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  it('/clear zeroes every counter', async () => {
    const c = makeCtx();
    expect(await handleUsageCommand('/clear', c)).toEqual({ handled: true });
    expect(c.cumulative).toEqual({
      turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    });
  });

  it('/clear says the conversation history is untouched', async () => {
    // Without this line "reset" reads as "start fresh", and a user who believes
    // it keeps paying to resend a history that was never dropped.
    await handleUsageCommand('/clear', makeCtx());
    expect(out()).toContain('history is unchanged');
    expect(out()).toMatch(/:new|:clear-history/);
  });

  it('/reset is the same command as /clear', async () => {
    const c = makeCtx();
    expect(await handleUsageCommand('/reset', c)).toEqual({ handled: true });
    expect(c.cumulative.turns).toBe(0);
  });

  it('/stats reports the counters without resetting them', async () => {
    const c = makeCtx();
    expect(await handleUsageCommand('/stats', c)).toEqual({ handled: true });
    expect(c.cumulative).toEqual(counters());
    const printed = out();
    expect(printed).toContain('Turns:        7');
    expect(printed).toContain('Tool calls:   12');
    expect(printed).toContain('Total tokens: 5,500');
    expect(printed).toContain('0.1234');
  });

  it('/usage is the same command as /stats', async () => {
    expect(await handleUsageCommand('/usage', makeCtx())).toEqual({ handled: true });
    expect(out()).toContain('Session usage:');
  });

  it('/context hands the dashboard the session turn and tool counts', async () => {
    // The tracker keeps its own turn/tool tallies, which the REPL does not
    // drive; the displayed numbers must be the session counters instead.
    const c = makeCtx();
    expect(await handleUsageCommand('/context', c)).toEqual({ handled: true });
    expect(c.dashboards).toHaveLength(1);
    expect(c.dashboards[0]!.turnCount).toBe(7);
    expect(c.dashboards[0]!.toolCallCount).toBe(12);
    expect(c.dashboards[0]!.totalInputTokens).toBe(4000);
  });

  it('/context is a no-op when the display has no dashboard renderer', async () => {
    const c = makeCtx({ display: {} });
    expect(await handleUsageCommand('/context', c)).toEqual({ handled: true });
  });

  it('/context tune is left for the caller — it drives the shared readline', async () => {
    expect(await handleUsageCommand('/context tune', makeCtx())).toBeNull();
    expect(await handleUsageCommand('/ct', makeCtx())).toBeNull();
  });

  it('returns null for anything else, so the caller keeps matching', async () => {
    expect(await handleUsageCommand(':help', makeCtx())).toBeNull();
    expect(await handleUsageCommand('/clearly not a command', makeCtx())).toBeNull();
  });
});

describe('/cost', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); vi.resetModules(); vi.doUnmock('../src/cli/cost-report.js'); });

  it('defaults to the last 20 entries and passes a numeric argument through', async () => {
    const seen: number[] = [];
    vi.doMock('../src/cli/cost-report.js', () => ({
      readTokenLog: (root: string) => { expect(root).toBe(PROJECT); return []; },
      formatCostReport: (_entries: unknown[], recent: number) => { seen.push(recent); return ''; },
    }));
    vi.resetModules();
    const { handleUsageCommand: fresh } = await import('../src/cli/repl-usage-commands.js');

    expect(await fresh('/cost', makeCtx())).toEqual({ handled: true });
    expect(await fresh('/cost 5', makeCtx())).toEqual({ handled: true });
    // A non-numeric argument falls back to the default rather than passing NaN
    // down into the report's slice.
    expect(await fresh('/cost lots', makeCtx())).toEqual({ handled: true });
    expect(seen).toEqual([20, 5, 20]);
  });
});

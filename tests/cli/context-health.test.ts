import { describe, it, expect } from 'vitest';
import { ContextHealthTracker, formatContextBar, formatContextDashboard } from '../../src/cli/context-health.js';
import type { HistoryMessage } from '../../src/providers/types.js';

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const history: HistoryMessage[] = [
  { role: 'user', content: 'Build macOS support for Aura Pulse telemetry pipeline' },
  { role: 'assistant', content: 'Let me analyze the telemetry module first.' },
  { role: 'tool_result', results: [{ name: 'read_file', content: 'file contents' }] },
];

describe('ContextHealthTracker', () => {
  it('snapshot reports estimated tokens, window, and a clean integer next-compaction percent', () => {
    const t = new ContextHealthTracker(() => 'system', () => history, 'gpt-4o', 'gpt-4o');
    const h = t.snapshot(1000, 500);
    expect(h.contextWindow).toBe(128_000);
    expect(h.estimatedTokens).toBeGreaterThan(0);
    expect(h.usagePercent).toBeGreaterThan(0);
    expect(Number.isInteger(h.nextCompactionPercent)).toBe(true);
    expect(h.nextCompactionPercent).toBe(55);
    expect(h.rolloversRemaining).toBe(3);
    expect(h.recapGeneration).toBe(0);
  });

  it('increments turns and tool calls', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    t.incrementTurn();
    t.incrementTurn();
    t.incrementToolCalls(4);
    const h = t.snapshot(0, 0);
    expect(h.turnCount).toBe(2);
    expect(h.toolCallCount).toBe(4);
  });

  it('records compaction events and surfaces them in history', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    t.incrementTurn();
    t.recordCompaction(80_000, 35_000, 1);
    const h = t.snapshot(0, 0);
    expect(h.compactionCount).toBe(1);
    expect(h.compactionHistory).toHaveLength(1);
    expect(h.compactionHistory[0].turn).toBe(1);
    expect(h.compactionHistory[0].beforeTokens).toBe(80_000);
    expect(h.compactionHistory[0].afterTokens).toBe(35_000);
  });

  it('updateSystem swaps the system-prompt source so token estimates change', () => {
    const t = new ContextHealthTracker(() => 'short', () => history, 'gpt-4o', 'gpt-4o');
    const before = t.snapshot(0, 0).estimatedTokens;
    t.updateSystem('x'.repeat(10_000));
    const after = t.snapshot(0, 0).estimatedTokens;
    expect(after).toBeGreaterThan(before);
  });

  it('computes cost from pricingModel + passed token totals', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    const h = t.snapshot(1_000_000, 1_000_000);
    // gpt-4o: $2.50/M in, $10/M out -> 2.5 + 10 = 12.5
    expect(h.totalCostUsd).toBeCloseTo(12.5, 2);
  });
});

describe('formatContextBar', () => {
  it('renders the bar, percent, compact threshold, and turn count', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    t.incrementTurn();
    const out = strip(formatContextBar(t.snapshot(0, 0)));
    expect(out).toContain('Context:');
    expect(out).toMatch(/█|░|┊/);
    expect(out).toContain('compact @ 55% (70k)');
    expect(out).toContain('turns');
  });

  it('places ladder marker ticks in the empty region of the bar', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    const out = strip(formatContextBar(t.snapshot(0, 0)));
    // 20-wide bar at ~0%: all empty, ticks at floor(0.55*20)=11, 14, 17
    expect(out).toContain('┊');
  });
});

describe('formatContextDashboard', () => {
  it('includes window, used, free, next fire, ladder with flush, and session totals', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    t.incrementTurn();
    t.incrementToolCalls(3);
    const h = t.snapshot(12_000, 4_000);
    h.turnCount = 5;
    const out = strip(formatContextDashboard(h));
    expect(out).toContain('Context Health Dashboard');
    expect(out).toContain('Window:');
    expect(out).toContain('Used:');
    expect(out).toContain('Free:');
    expect(out).toContain('Next fire:');
    expect(out).toContain('Ladder:');
    expect(out).toContain('flush');
    expect(out).toContain('Session totals');
    expect(out).toContain('Turns:');
    expect(out).toContain('Tools:');
  });

  it('Free = contextWindow - estimated (not tokens-until-compaction)', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    const h = t.snapshot(0, 0);
    const out = strip(formatContextDashboard(h));
    const expectedFree = (h.contextWindow - h.estimatedTokens).toLocaleString();
    expect(out).toContain('Free:      ' + expectedFree);
  });

  it('shows compaction history when events were recorded', () => {
    const t = new ContextHealthTracker(() => 's', () => history, 'gpt-4o', 'gpt-4o');
    t.incrementTurn();
    t.recordCompaction(80_000, 35_000, 1);
    const out = strip(formatContextDashboard(t.snapshot(0, 0)));
    expect(out).toContain('Compaction history');
    expect(out).toContain('80,000');
    expect(out).toContain('35,000');
  });

  it('lists largest messages with system prompt as a virtual sys entry', () => {
    const t = new ContextHealthTracker(() => 'system prompt text', () => history, 'gpt-4o', 'gpt-4o');
    const out = strip(formatContextDashboard(t.snapshot(0, 0)));
    expect(out).toContain('Largest messages');
    expect(out).toContain('sys');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LADDER,
  DEFAULT_MAX_CONTEXT_TOKENS,
  getLadder,
  getMaxContextTokens,
  compactionThreshold,
  retentionBudget,
  thresholdRatioFor,
  setModelPolicies,
  resolveModelPolicy,
  resetLadder,
} from '../src/agent/context-policy.js';

// Every test mutates process-scoped policy state, so reset before each.
beforeEach(() => resetLadder());

describe('global defaults (no per-model policy)', () => {
  it('uses the default ladder and ceiling', () => {
    expect(getLadder()).toEqual(DEFAULT_LADDER);
    expect(getMaxContextTokens()).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    // window * rung0 (0.55) = 55,000, under the 80,000 ceiling.
    expect(compactionThreshold(100_000, 0)).toBe(55_000);
    // On a 1M window the 80,000 ceiling binds instead of the ladder.
    expect(compactionThreshold(1_000_000, 0)).toBe(80_000);
  });
});

describe('per-model ceiling override', () => {
  it('lowers the trigger when the override cap binds', () => {
    const policy = { maxContextTokens: 20_000 };
    expect(compactionThreshold(100_000, 0, policy)).toBe(20_000);
  });

  it('raises the trigger on a large-window model', () => {
    const policy = { maxContextTokens: 200_000 };
    expect(compactionThreshold(1_000_000, 0, policy)).toBe(200_000);
  });

  it('treats 0 as "no cap" (ladder-only), matching the global setter', () => {
    const policy = { maxContextTokens: 0 };
    expect(compactionThreshold(1_000_000, 0, policy)).toBe(550_000);
  });

  it('falls through to the global ceiling when left unset', () => {
    // Ladder-only override: ceiling still the global 80,000.
    const policy = { ladder: [0.3] };
    expect(compactionThreshold(1_000_000, 0, policy)).toBe(80_000);
  });
});

describe('per-model ladder override', () => {
  it('uses the override ladder and clamps past the last rung', () => {
    const policy = { ladder: [0.3, 0.5] };
    expect(thresholdRatioFor(0, policy)).toBe(0.3);
    expect(thresholdRatioFor(1, policy)).toBe(0.5);
    expect(thresholdRatioFor(9, policy)).toBe(0.5);
    expect(compactionThreshold(100_000, 0, policy)).toBe(30_000);
  });
});

describe('per-model retention override', () => {
  it('changes the tail budget via retentionRatio', () => {
    // Global: min(40,000, 55,000*0.75=41,250) = 40,000.
    expect(retentionBudget(100_000)).toBe(40_000);
    // Override: min(50,000, 41,250) = 41,250.
    expect(retentionBudget(100_000, { retentionRatio: 0.5 })).toBe(41_250);
  });
});

describe('model policy registry', () => {
  it('matches by exact key and by stripped candidate', () => {
    setModelPolicies([{ model: 'deepseek-v4-pro', maxContextTokens: 12345 }]);
    expect(resolveModelPolicy(['deepseek-v4-pro'])?.maxContextTokens).toBe(12345);
    // Mirrors getContextWindow: [raw, stripRoutingPrefix(model)] candidates.
    expect(
      resolveModelPolicy(['openrouter/deepseek-v4-pro', 'deepseek-v4-pro'])?.maxContextTokens,
    ).toBe(12345);
    expect(resolveModelPolicy(['other-model'])).toBeUndefined();
  });

  it('replaces the whole table on each install and clears on reset', () => {
    setModelPolicies([{ model: 'a', maxContextTokens: 1 }]);
    setModelPolicies([{ model: 'b', maxContextTokens: 2 }]);
    expect(resolveModelPolicy(['a'])).toBeUndefined();
    expect(resolveModelPolicy(['b'])?.maxContextTokens).toBe(2);

    resetLadder();
    expect(resolveModelPolicy(['b'])).toBeUndefined();
    expect(getLadder()).toEqual(DEFAULT_LADDER);
    expect(getMaxContextTokens()).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });
});

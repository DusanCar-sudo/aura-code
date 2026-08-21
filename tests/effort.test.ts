import { describe, it, expect } from 'vitest';
import {
  EFFORT_LEVELS, isEffortLevel, parseEffort,
  supportsFullLadder, clampEffort, wasClamped,
} from '../src/providers/effort.js';
import { resolveConfig } from '../src/config/project-config.js';

describe('effort ladder', () => {
  it('matches the variants DeepSeek accepts, in ascending order', () => {
    // Verified live 2026-08-05: a bad value 400s with exactly this list.
    expect([...EFFORT_LEVELS]).toEqual(
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
  });

  it('parses case- and whitespace-tolerantly, rejects junk', () => {
    expect(parseEffort('MAX')).toBe('max');
    expect(parseEffort('  high  ')).toBe('high');
    expect(parseEffort('ultra')).toBeUndefined();
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort(7)).toBeUndefined();
    expect(isEffortLevel('xhigh')).toBe(true);
    expect(isEffortLevel('xxhigh')).toBe(false);
  });
});

describe('per-provider clamping', () => {
  it('recognises DeepSeek by model id and by endpoint', () => {
    expect(supportsFullLadder({ model: 'deepseek-v4-flash' })).toBe(true);
    expect(supportsFullLadder({ model: 'deepseek/deepseek-v4-pro' })).toBe(true);
    // A custom .aura.json provider can label DeepSeek anything it likes.
    expect(supportsFullLadder({ model: 'house-blend', baseUrl: 'https://api.deepseek.com/v1' }))
      .toBe(true);
    expect(supportsFullLadder({ model: 'glm-5.2' })).toBe(false);
  });

  it('passes the full ladder through to DeepSeek untouched', () => {
    for (const lvl of EFFORT_LEVELS) {
      expect(clampEffort(lvl, { model: 'deepseek-v4-flash' })).toBe(lvl);
      expect(wasClamped(lvl, { model: 'deepseek-v4-flash' })).toBe(false);
    }
  });

  it('folds the outer rungs inward for three-rung providers', () => {
    const glm = { model: 'glm-5.2' };
    expect(clampEffort('none', glm)).toBe('low');
    expect(clampEffort('minimal', glm)).toBe('low');
    expect(clampEffort('medium', glm)).toBe('medium');
    expect(clampEffort('xhigh', glm)).toBe('high');
    expect(clampEffort('max', glm)).toBe('high');
    expect(wasClamped('max', glm)).toBe(true);
    expect(wasClamped('high', glm)).toBe(false);
  });

  it('never emits a rung outside the OpenAI trio for unknown providers', () => {
    for (const lvl of EFFORT_LEVELS) {
      expect(['low', 'medium', 'high']).toContain(clampEffort(lvl, { model: 'gpt-4o' }));
    }
  });
});

describe('config precedence', () => {
  const defaults = { model: 'm', mode: 'normal' as const, ignore: [] };

  it('lets --effort beat .aura.json', () => {
    const r = resolveConfig({ effort: 'low' }, { effort: 'max' }, defaults);
    expect(r.effort).toBe('max');
  });

  it('falls back to .aura.json when no flag is given', () => {
    const r = resolveConfig({ effort: 'low' }, {}, defaults);
    expect(r.effort).toBe('low');
  });

  it('leaves effort undefined so the provider default stands', () => {
    expect(resolveConfig({}, {}, defaults).effort).toBeUndefined();
  });
});

/**
 * AURA_MAX_TOKENS. Measured on glm-5.2 via OpenCode Go at effort "max": a
 * long-output request came back outputTokens=16384, finish_reason "length",
 * content EMPTY — the entire budget spent reasoning, artefact never emitted.
 * The ceiling has to be liftable without a code change.
 */
describe('envMaxTokens', () => {
  const saved = process.env.AURA_MAX_TOKENS;
  afterEach(() => {
    if (saved === undefined) delete process.env.AURA_MAX_TOKENS;
    else process.env.AURA_MAX_TOKENS = saved;
  });

  it('reads a positive integer', async () => {
    const { envMaxTokens } = await import('../src/providers/openai-compatible.js');
    process.env.AURA_MAX_TOKENS = '32768';
    expect(envMaxTokens()).toBe(32768);
  });

  it('ignores unset, zero, negative and non-numeric values rather than throwing', async () => {
    const { envMaxTokens } = await import('../src/providers/openai-compatible.js');
    delete process.env.AURA_MAX_TOKENS;
    expect(envMaxTokens()).toBeUndefined();
    for (const bad of ['', '0', '-5', 'lots', 'NaN']) {
      process.env.AURA_MAX_TOKENS = bad;
      expect(envMaxTokens()).toBeUndefined();
    }
  });

  it('floors a fractional value', async () => {
    const { envMaxTokens } = await import('../src/providers/openai-compatible.js');
    process.env.AURA_MAX_TOKENS = '20000.7';
    expect(envMaxTokens()).toBe(20000);
  });
});

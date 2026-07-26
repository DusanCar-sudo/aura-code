import { describe, it, expect } from 'vitest';
import { classifyTask, getLoopProfile, detectStall, DEFAULT_MAX_TURNS, DEFAULT_STALL_THRESHOLD } from '../src/agent/loop-profile.js';

describe('classifyTask', () => {
  it('defaults to single-file', () => {
    expect(classifyTask('fix the off-by-one in utils.ts')).toBe('single-file');
  });

  it('detects multi-file signals', () => {
    expect(classifyTask('add logging to all endpoints')).toBe('multi-file');
    expect(classifyTask('rename the helper across the entire codebase')).toBe('multi-file');
  });

  it('detects exploratory signals', () => {
    expect(classifyTask('explain why does the cache miss on restart')).toBe('exploratory');
    expect(classifyTask('investigate the flaky login test')).toBe('exploratory');
  });
});

describe('getLoopProfile', () => {
  // Flat cap, no shape-based ladder — see loop-profile.ts for why the old
  // adaptive sizing was replaced (pi's agent loop has no turn-budget concept
  // at all; this keeps one flat ceiling as aura's one deliberate departure).
  it('defaults to a flat ceiling regardless of task shape', () => {
    const p = getLoopProfile();
    expect(p.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(p.stallThreshold).toBe(DEFAULT_STALL_THRESHOLD);
  });

  it('uses an explicit override as the ceiling', () => {
    const p = getLoopProfile(12);
    expect(p.maxTurns).toBe(12);
    expect(p.stallThreshold).toBe(DEFAULT_STALL_THRESHOLD);
  });
});

describe('detectStall', () => {
  const sig = (n: string) => JSON.stringify([{ name: n, input: {} }]);

  it('returns null while signatures vary', () => {
    expect(detectStall([sig('a'), sig('b'), sig('c')], 3)).toBeNull();
  });

  it('detects exact repetition (A A A)', () => {
    expect(detectStall([sig('x'), sig('a'), sig('a'), sig('a')], 3)).toBe('repeat');
  });

  it('does not fire repeat below the threshold', () => {
    expect(detectStall([sig('a'), sig('a')], 3)).toBeNull();
  });

  it('detects two-call cycles (A B A B A B)', () => {
    const seq = [sig('a'), sig('b'), sig('a'), sig('b'), sig('a'), sig('b')];
    expect(detectStall(seq, 3)).toBe('cycle');
  });

  it('does not fire cycle on an incomplete alternation', () => {
    const seq = [sig('a'), sig('b'), sig('a'), sig('b'), sig('a')];
    expect(detectStall(seq, 3)).toBeNull();
  });

  it('does not fire cycle when the pattern breaks mid-window', () => {
    const seq = [sig('a'), sig('b'), sig('a'), sig('c'), sig('a'), sig('b')];
    expect(detectStall(seq, 3)).toBeNull();
  });
});

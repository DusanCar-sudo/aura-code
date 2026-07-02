import { describe, it, expect } from 'vitest';
import { classifyTask, getLoopProfile, detectStall } from '../src/agent/loop-profile.js';

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
  it('sizes single-file with a widenTo tier', () => {
    const p = getLoopProfile('fix the bug in parser.ts');
    expect(p.shape).toBe('single-file');
    expect(p.maxTurns).toBe(30);
    expect(p.stallThreshold).toBe(3);
    expect(p.widenTo).toBe(80);
  });

  it('gives top-tier shapes no widenTo', () => {
    expect(getLoopProfile('refactor every file in src').widenTo).toBeUndefined();
  });

  it('treats an explicit override as a hard ceiling — no widening', () => {
    const p = getLoopProfile('fix the bug in parser.ts', 12);
    expect(p.maxTurns).toBe(12);
    expect(p.widenTo).toBeUndefined();
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

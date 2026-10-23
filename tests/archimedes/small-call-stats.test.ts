import { describe, it, expect } from 'vitest';
import { formatSmallCallStats } from '../../src/archimedes/alternator.js';

describe('formatSmallCallStats', () => {
  it('splits output into reasoning and content tokens when the server reports reasoning_tokens', () => {
    const line = formatSmallCallStats({
      promptTokens: 15, outputTokens: 59, reasoningTokens: 56, reasoningChars: 200,
      firstChunkMs: 400, firstAnswerMs: 6900, totalMs: 7200,
    });
    expect(line).toContain('prompt=15tok');
    expect(line).toContain('ttft=0.4s');
    expect(line).toContain('reasoning=56tok content=3tok');
  });

  it('falls back to reasoning characters when no token split is reported', () => {
    const line = formatSmallCallStats({ outputTokens: 10, reasoningChars: 42, firstChunkMs: 100, totalMs: 1100 });
    expect(line).toContain('reasoning=42ch');
    expect(line).toContain('10.0 tok/s');
  });
});

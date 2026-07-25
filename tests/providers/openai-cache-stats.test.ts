import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { readCacheStats } from '../../src/providers/openai-compatible.js';
import { costFor } from '../../src/agent/loop.js';

const usage = (extra: Record<string, unknown>, prompt = 100_000): OpenAI.CompletionUsage =>
  ({ prompt_tokens: prompt, completion_tokens: 200, total_tokens: prompt + 200, ...extra }) as OpenAI.CompletionUsage;

describe('readCacheStats', () => {
  it('reads the OpenAI-standard field (Zhipu/GLM, OpenAI)', () => {
    const s = readCacheStats(usage({ prompt_tokens_details: { cached_tokens: 98_000 } }));
    expect(s.cacheHit).toBe(98_000);
    expect(s.cacheMiss).toBe(2_000);
  });

  it('still reads the DeepSeek dialect', () => {
    const s = readCacheStats(usage({
      prompt_cache_hit_tokens: 90_000,
      prompt_cache_miss_tokens: 10_000,
    }));
    expect(s.cacheHit).toBe(90_000);
    expect(s.cacheMiss).toBe(10_000);
  });

  it('reports no hits when a provider sends neither dialect', () => {
    const s = readCacheStats(usage({}));
    expect(s.cacheHit).toBe(0);
    expect(s.cacheMiss).toBe(100_000);
  });

  it('ignores a zeroed field in favour of the dialect that reports a hit', () => {
    const s = readCacheStats(usage({
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 75_000,
    }));
    expect(s.cacheHit).toBe(75_000);
  });

  it('tolerates a missing details object', () => {
    expect(readCacheStats(usage({ prompt_tokens_details: undefined })).cacheHit).toBe(0);
  });

  it('never reports negative misses', () => {
    const s = readCacheStats(usage({ prompt_tokens_details: { cached_tokens: 999_999 } }));
    expect(s.cacheMiss).toBe(0);
  });
});

describe('billing impact of the fix', () => {
  // The bug this fixes: a fully-cached GLM turn was billed at the full rate
  // because the standard field was never read.
  it('bills a cached GLM turn ~10x cheaper once the field is parsed', () => {
    const u = usage({ prompt_tokens_details: { cached_tokens: 98_000 } });
    const before = costFor('glm-5.2', 100_000, 200);                       // cachedTokens undefined
    const after = costFor('glm-5.2', 100_000, 200, readCacheStats(u).cacheHit);
    expect(after).toBeLessThan(before / 5);
    expect(before / after).toBeGreaterThan(5);
  });
});

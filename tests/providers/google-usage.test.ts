import { describe, it, expect } from 'vitest';
import { fromGoogleResponse } from '../../src/providers/google.js';

describe('google usage metadata — context-cache visibility', () => {
  it('reads cachedContentTokenCount so cached turns are not billed full-rate', () => {
    const r = fromGoogleResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 1_000,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 800,
      },
    });
    expect(r.usage).toEqual({ inputTokens: 1_000, outputTokens: 40, cachedTokens: 800 });
  });

  it('also reads per-modality cachedTokenCount details', () => {
    const r = fromGoogleResponse({
      candidates: [],
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 10,
        promptTokensDetails: [{ cachedTokenCount: 300 }, { cachedTokenCount: 100 }],
      },
    });
    expect(r.usage?.cachedTokens).toBe(400);
  });

  it('leaves cachedTokens unset when the provider reports no cache fields', () => {
    const r = fromGoogleResponse({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 10 },
    });
    expect(r.usage).toEqual({ inputTokens: 90, outputTokens: 10 });
  });

  it('returns no usage when metadata is absent', () => {
    expect(fromGoogleResponse({ candidates: [] }).usage).toBeUndefined();
  });
});

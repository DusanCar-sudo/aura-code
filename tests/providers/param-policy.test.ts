import { describe, it, expect } from 'vitest';
import { paramPolicyFor } from '../../src/providers/param-policy.js';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';

// ─────────────────────────────────────────────────────────────────────────────
// The bug these guard against:
//
// Aura sends temperature 0.2 and penalties 0.3 by default. Moonshot pins all
// three (temperature 1, penalties 0) and answers anything else with a hard
// 400 — so on Kimi *every* request failed before a token was generated, and a
// plain "hello" came back as "Provider error: HTTP 400: 400 invalid
// temperature: only 1 is allowed for this model".
//
// The walls stand behind each other: correcting temperature alone surfaces
// "invalid presence_penalty: only 0 is allowed" on the next request. Verified
// live against api.moonshot.ai on 2026-09-03.
// ─────────────────────────────────────────────────────────────────────────────

describe('paramPolicyFor', () => {
  it('pins every parameter Moonshot refuses to vary, not just the first one', () => {
    const p = paramPolicyFor({ model: 'kimi/kimi-k3' });
    expect(p).toEqual({ temperature: 1, frequencyPenalty: 0, presencePenalty: 0 });
  });

  it('recognises the endpoint by model prefix, bare model id, or base URL', () => {
    // The factory reaches this provider by all three routes — a `kimi/` id, a
    // bare Moonshot model name, and a custom .aura.json provider that points
    // at the same endpoint under a name of its own.
    for (const target of [
      { model: 'kimi/kimi-k2.6' },
      { model: 'kimi-k3' },
      { model: 'moonshot-v1-8k' },
      { model: 'house-blend', baseUrl: 'https://api.moonshot.ai/v1' },
      { model: 'house-blend', baseUrl: 'https://api.moonshot.cn/v1' },
    ]) {
      expect(paramPolicyFor(target)?.temperature).toBe(1);
    }
  });

  it('leaves every other endpoint alone', () => {
    for (const target of [
      { model: 'deepseek-v4-flash' },
      { model: 'glm-5.3-flash', baseUrl: 'https://api.z.ai/api/paas/v4' },
      { model: 'gpt-4o' },
      {},
    ]) {
      expect(paramPolicyFor(target)).toBeUndefined();
    }
  });
});

describe('OpenAICompatibleProvider sampling parameters', () => {
  /** The fields the provider will actually put on the wire. */
  const sampling = (config: Record<string, unknown>) => {
    const p = new OpenAICompatibleProvider({ apiKey: 'k', ...config } as never) as unknown as {
      temperature: number; frequencyPenalty: number; presencePenalty: number;
    };
    return { temperature: p.temperature, frequency: p.frequencyPenalty, presence: p.presencePenalty };
  };

  it('keeps the code-generation defaults where the endpoint allows them', () => {
    expect(sampling({ model: 'deepseek-v4-flash' }))
      .toEqual({ temperature: 0.2, frequency: 0.3, presence: 0.3 });
  });

  it('applies the whole policy on a pinned endpoint', () => {
    expect(sampling({ model: 'kimi/kimi-k3' }))
      .toEqual({ temperature: 1, frequency: 0, presence: 0 });
  });

  it('lets the policy win over an explicit value, because a rejected request honours nothing', () => {
    expect(sampling({ model: 'kimi/kimi-k3', temperature: 0, frequencyPenalty: 0.5, presencePenalty: 0.5 }))
      .toEqual({ temperature: 1, frequency: 0, presence: 0 });
  });

  it('still honours an explicit value where there is no policy', () => {
    expect(sampling({ model: 'deepseek-v4-flash', temperature: 0.9 }).temperature).toBe(0.9);
  });
});

import { authErrorHint } from '../../src/providers/param-policy.js';

describe('authErrorHint', () => {
  it('recognises a key saved into the wrong provider\'s slot', () => {
    // Seen in the wild: an OpenRouter key under MOONSHOT_API_KEY — every Kimi
    // request 401s with a bare "Invalid Authentication" that says nothing.
    expect(authErrorHint({ model: 'kimi/kimi-k3' }, 'sk-or-v1-6abc…5ed6'))
      .toContain('OpenRouter key');
  });

  it('stays quiet when the key belongs to the provider being called', () => {
    expect(authErrorHint({ model: 'openrouter/moonshotai/kimi-k3' }, 'sk-or-v1-6abc…5ed6'))
      .toBeUndefined();
    // Moonshot's own keys are bare `sk-…` — no prefix matches, no hint.
    expect(authErrorHint({ model: 'kimi/kimi-k3' }, 'sk-0123456789abcdef')).toBeUndefined();
    expect(authErrorHint({ model: 'kimi/kimi-k3' }, undefined)).toBeUndefined();
  });
});

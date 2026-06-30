import { describe, it, expect } from 'vitest';
import { KNOWN_MODELS, getAllModels } from '../src/providers/factory.js';

describe('KNOWN_MODELS', () => {
  it('contains at least 30 entries', () => {
    expect(KNOWN_MODELS.length).toBeGreaterThanOrEqual(30);
  });

  it('covers all major providers', () => {
    const providers = new Set(KNOWN_MODELS.map(m => m.provider));
    for (const p of ['Anthropic', 'OpenAI', 'Google', 'Xiaomi MiMo', 'xAI', 'OpenRouter', 'Ollama', 'Local']) {
      expect(providers.has(p)).toBe(true);
    }
  });

  it('every entry has unique id, name, provider, speed', () => {
    const ids = new Set<string>();
    for (const m of KNOWN_MODELS) {
      expect(ids.has(m.id)).toBe(false);  // unique
      ids.add(m.id);
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.provider).toBeTruthy();
      expect(m.speed).toBeTruthy();
    }
  });

  it('has multiple Claude models (not just one)', () => {
    const claude = KNOWN_MODELS.filter(m => m.id.startsWith('claude-'));
    expect(claude.length).toBeGreaterThanOrEqual(3);
  });

  it('has multiple GPT models (not just one)', () => {
    const gpt = KNOWN_MODELS.filter(m => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('o4'));
    expect(gpt.length).toBeGreaterThanOrEqual(5);
  });

  it('has multiple Gemini models', () => {
    const gemini = KNOWN_MODELS.filter(m => m.id.startsWith('gemini-'));
    expect(gemini.length).toBeGreaterThanOrEqual(5);
  });

  it('has multiple OpenRouter models across vendors', () => {
    const or = KNOWN_MODELS.filter(m => m.id.startsWith('openrouter/'));
    expect(or.length).toBeGreaterThanOrEqual(10);
  });

  it('has multiple Ollama models for local use', () => {
    const ollama = KNOWN_MODELS.filter(m => m.id.startsWith('ollama/'));
    expect(ollama.length).toBeGreaterThanOrEqual(8);
  });
});

describe('getAllModels', () => {
  it('returns built-in models by default', () => {
    const all = getAllModels();
    expect(all.length).toBe(KNOWN_MODELS.length);
  });
});

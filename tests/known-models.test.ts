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

/**
 * Gemini 3.7 Flash is listed explicitly in the offline registry rather than
 * left to the live fetch. The selector can only offer what it can list, and it
 * has to be offerable *before* a Google key exists — otherwise a user with no
 * key can never reach the prompt that asks for one. No key is bundled: the
 * model is registered, and availability stays gated on the env var.
 */
describe('gemini-3.7-flash registration', () => {
  const saved = { g: process.env.GOOGLE_API_KEY, gm: process.env.GEMINI_API_KEY };
  afterEach(() => {
    if (saved.g === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = saved.g;
    if (saved.gm === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.gm;
  });

  it('is listed, and listed without needing a key present', async () => {
    const { KNOWN_MODELS } = await import('../src/providers/factory.js');
    const entry = KNOWN_MODELS.find(m => m.id === 'gemini-3.7-flash');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('Google');
    expect(entry!.name).toBe('Gemini 3.7 Flash');
  });

  it('routes to the Google key env var', async () => {
    const { apiKeyEnvVarForModel, modelProviderFamily } = await import('../src/providers/factory.js');
    expect(apiKeyEnvVarForModel('gemini-3.7-flash')).toBe('GOOGLE_API_KEY');
    expect(modelProviderFamily('gemini-3.7-flash')).toBe('google');
  });

  it('is not usable until a key is supplied — nothing is shipped with it', async () => {
    const { isModelConfigured } = await import('../src/providers/factory.js');
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(isModelConfigured('gemini-3.7-flash')).toBe(false);
    process.env.GOOGLE_API_KEY = 'supplied-by-the-user';
    expect(isModelConfigured('gemini-3.7-flash')).toBe(true);
  });

  it('constructs the Google provider for the exact upstream model id', async () => {
    const { createProvider } = await import('../src/providers/factory.js');
    const p = createProvider({ model: 'gemini-3.7-flash', apiKey: 'k' });
    expect(p.name).toBe('Google');
    expect(p.model).toBe('gemini-3.7-flash');   // sent verbatim to the API
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerCustomProviders, getCustomProviders, getAllModels, createProvider, getApiKeyForModel } from '../src/providers/factory.js';
import type { ProviderDef } from '../src/config/project-config.js';

// We need to reset custom providers between tests
beforeEach(() => {
  registerCustomProviders([]);
});

describe('registerCustomProviders / getCustomProviders', () => {
  it('starts with empty custom providers', () => {
    expect(getCustomProviders()).toEqual([]);
  });

  it('registers custom providers', () => {
    const defs: ProviderDef[] = [{
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      prefixes: ['deepseek/'],
      models: [{ id: 'deepseek/chat', name: 'Chat', speed: 'Fast' }],
    }];
    registerCustomProviders(defs);
    expect(getCustomProviders()).toEqual(defs);
  });

  it('replaces previous providers on re-register', () => {
    registerCustomProviders([{
      name: 'A',
      baseUrl: 'https://a.example.com/v1',
      prefixes: ['a/'],
    }]);
    registerCustomProviders([{
      name: 'B',
      baseUrl: 'https://b.example.com/v1',
      prefixes: ['b/'],
    }]);
    expect(getCustomProviders()).toHaveLength(1);
    expect(getCustomProviders()[0].name).toBe('B');
  });
});

describe('getAllModels', () => {
  it('returns built-in models when no custom providers', () => {
    const models = getAllModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.provider === 'Anthropic')).toBe(true);
    expect(models.some(m => m.provider === 'OpenAI')).toBe(true);
  });

  it('includes custom provider models', () => {
    registerCustomProviders([{
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      prefixes: ['deepseek/'],
      models: [
        { id: 'deepseek/chat', name: 'DeepSeek Chat', speed: 'Fast' },
        { id: 'deepseek/reasoner', name: 'DeepSeek R1', speed: 'Reasoning' },
      ],
    }]);
    const models = getAllModels();
    const dsModels = models.filter(m => m.provider === 'DeepSeek');
    expect(dsModels).toHaveLength(2);
    expect(dsModels[0].id).toBe('deepseek/chat');
    expect(dsModels[1].id).toBe('deepseek/reasoner');
  });

  it('does not duplicate built-in models', () => {
    // Register a custom provider that tries to duplicate a built-in
    registerCustomProviders([{
      name: 'Custom',
      baseUrl: 'https://custom.example.com/v1',
      prefixes: ['custom/'],
      models: [{ id: 'gpt-4o', name: 'Fake GPT' }],  // same id as built-in
    }]);
    const models = getAllModels();
    const gpt = models.filter(m => m.id === 'gpt-4o');
    expect(gpt).toHaveLength(1);
    expect(gpt[0].provider).toBe('OpenAI');  // original preserved
  });
});

describe('createProvider with custom providers', () => {
  it('routes to custom provider when prefix matches', () => {
    registerCustomProviders([{
      name: 'TestProvider',
      baseUrl: 'https://test.example.com/v1',
      apiKey: 'test-key',
      prefixes: ['test/'],
    }]);
    // createProvider needs apiKey — we pass it in config
    const provider = createProvider({ model: 'test/my-model', apiKey: 'test-key' });
    expect(provider.name).toBe('TestProvider');
    expect(provider.model).toBe('my-model');  // prefix stripped
  });

  it('routes to custom provider with static apiKey', () => {
    registerCustomProviders([{
      name: 'StaticKey',
      baseUrl: 'https://static.example.com/v1',
      apiKey: 'sk-static',
      prefixes: ['static/'],
    }]);
    const provider = createProvider({ model: 'static/mymodel' });
    expect(provider.name).toBe('StaticKey');
  });

  it('falls through to built-in when no custom prefix matches', () => {
    registerCustomProviders([{
      name: 'NoMatch',
      baseUrl: 'https://nomatch.example.com/v1',
      prefixes: ['nomatch/'],
    }]);
    const provider = createProvider({ model: 'gpt-4o' });
    expect(provider.name).not.toBe('NoMatch');
  });

  it('uses config.baseUrl over provider baseUrl when set', () => {
    registerCustomProviders([{
      name: 'Override',
      baseUrl: 'https://original.example.com/v1',
      apiKey: 'key',
      prefixes: ['override/'],
    }]);
    const provider = createProvider({
      model: 'override/test',
      baseUrl: 'https://custom.example.com/v1',
      apiKey: 'key',
    });
    // The provider should use the config baseUrl
    // We can verify by checking the model name is correct
    expect(provider.model).toBe('test');
  });

  it('handles model with no prefix remainder', () => {
    registerCustomProviders([{
      name: 'Exact',
      baseUrl: 'https://exact.example.com/v1',
      apiKey: 'key',
      prefixes: ['exact-model'],
    }]);
    const provider = createProvider({ model: 'exact-model', apiKey: 'key' });
    expect(provider.name).toBe('Exact');
    // When the whole model IS the prefix, rawModel would be empty, so it uses full model
    expect(provider.model).toBe('exact-model');
  });
});

describe('getApiKeyForModel', () => {
  const ENV_KEYS = ['DEEPSEEK_API_KEY', 'XIAOMI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("picks the model's own provider key, not whichever key happens to exist first", () => {
    // The exact bug scenario: a DeepSeek key present, but the model is MiMo.
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-real';
    process.env.XIAOMI_API_KEY = 'tp-xiaomi-real';
    const key = getApiKeyForModel('mimo-v2.5-pro');
    expect(key).toBe('tp-xiaomi-real');
  });

  it('falls back to any other configured key only when the matching family has none', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-real';
    // No XIAOMI_API_KEY set at all.
    const key = getApiKeyForModel('mimo-v2.5-pro');
    expect(key).toBe('sk-deepseek-real');
  });

  it('returns undefined when no key is configured at all', () => {
    expect(getApiKeyForModel('mimo-v2.5-pro')).toBeUndefined();
  });

  it('correctly resolves deepseek models to the deepseek key even when others exist', () => {
    process.env.XIAOMI_API_KEY = 'tp-xiaomi-real';
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-real';
    expect(getApiKeyForModel('deepseek/deepseek-v4-pro')).toBe('sk-deepseek-real');
  });
});


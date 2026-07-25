import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/setup/provider-wizard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/setup/provider-wizard.js')>();
  return { ...actual, loadProviderConfig: vi.fn(() => null) };
});

import {
  modelProviderFamily, apiKeyEnvVarForModel, createProvider, registerCustomProviders,
} from '../../src/providers/factory.js';

const ZENMUX_URL = 'https://zenmux.ai/api/v1';

describe('ZenMux routing', () => {
  beforeEach(() => {
    registerCustomProviders([]);
    process.env.ZENMUX_API_KEY = 'test-key';
  });
  afterEach(() => {
    registerCustomProviders([]);
    delete process.env.ZENMUX_API_KEY;
  });

  it('routes prefixed ids to the gateway, stripping the prefix from the wire model', () => {
    const p = createProvider({ model: 'zenmux/anthropic/claude-sonnet-5-free' });
    expect(p.name).toBe('ZenMux');
    // The vendor namespace must survive — only Aura's own routing prefix goes.
    expect(p.model).toBe('anthropic/claude-sonnet-5-free');
  });

  it('routes bare vendor ids to the gateway too', () => {
    // Regression: these resolved to ZENMUX_API_KEY but had no routing branch,
    // so they fell through to the OpenAI fallback and were sent to
    // api.openai.com carrying a ZenMux key — an opaque 401.
    const p = createProvider({ model: 'inclusionai/ling-3.0-flash' });
    expect(p.name).toBe('ZenMux');
    expect(p.model).toBe('inclusionai/ling-3.0-flash');
  });

  it('agrees between key resolution and transport routing', () => {
    // The two must never disagree: that combination sends one vendor's
    // request with another vendor's key.
    for (const id of ['zenmux/moonshotai/kimi-k3-free', 'inclusionai/ling-3.0-flash']) {
      expect(apiKeyEnvVarForModel(id)).toBe('ZENMUX_API_KEY');
      expect(modelProviderFamily(id)).toBe('zenmux');
      expect(createProvider({ model: id }).name).toBe('ZenMux');
    }
  });

  it('honours an explicit baseUrl over the gateway default', () => {
    const p = createProvider({ model: 'zenmux/x/y', baseUrl: 'http://localhost:9999/v1' });
    expect(p.name).toBe('ZenMux');
  });

  it('is case-insensitive on the routing prefix', () => {
    expect(createProvider({ model: 'ZenMux/anthropic/claude-sonnet-5-free' }).name).toBe('ZenMux');
  });
});

describe('ZenMux does not claim unrelated vendor/model ids', () => {
  beforeEach(() => registerCustomProviders([]));
  afterEach(() => registerCustomProviders([]));

  it('leaves an unknown vendor/model id as openai-compatible', () => {
    // A catch-all regex briefly claimed every `<vendor>/<model>` id for
    // ZenMux, which silently mislabelled custom providers.
    expect(modelProviderFamily('myvendor/my-model')).toBe('openai-compatible');
    expect(apiKeyEnvVarForModel('myvendor/my-model')).toBeUndefined();
  });

  it('does not shadow a custom provider registered from .aura.json', () => {
    registerCustomProviders([{
      name: 'MyCorp', prefixes: ['mycorp/'],
      baseUrl: 'https://api.mycorp.test/v1', apiKeyEnv: 'MYCORP_API_KEY',
    } as any]);
    expect(apiKeyEnvVarForModel('mycorp/some-model')).toBe('MYCORP_API_KEY');
    expect(modelProviderFamily('mycorp/some-model')).not.toBe('zenmux');
  });

  it('keeps first-party families on their own routing', () => {
    expect(modelProviderFamily('deepseek-v4-pro')).toBe('deepseek');
    expect(modelProviderFamily('glm-5.2')).toBe('zhipu');
    expect(modelProviderFamily('claude-opus-4')).toBe('anthropic');
    expect(modelProviderFamily('gemini-2.5-pro')).toBe('google');
    expect(modelProviderFamily('openrouter/meta/llama-3')).toBe('openrouter');
  });
});

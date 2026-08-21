import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/setup/provider-wizard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/setup/provider-wizard.js')>();
  return {
    ...actual,
    loadProviderConfig: vi.fn(() => null),
  };
});

import {
  createProvider,
  apiKeyEnvVarForModel,
  isModelConfigured,
  modelProviderFamily,
  getContextWindow,
  getAllModels,
  FPT_BASE_URL,
} from '../../src/providers/factory.js';
import { registerCustomProviders } from '../../src/providers/factory.js';

describe('FPT Cloud AI Marketplace Provider', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    process.env = { ...orig };
    registerCustomProviders([]);
  });

  it('routes fpt/ models to the FPT Cloud AI endpoint and strips the prefix', () => {
    process.env.FPT_API_KEY = 'fpt-test-key';
    const p = createProvider({ model: 'fpt/DeepSeek-V4-Flash' });
    expect(p.model).toBe('DeepSeek-V4-Flash');
    expect(p.name).toBe('FPT Cloud AI');
    const client = (p as unknown as { client: { baseURL: string; apiKey: string } }).client;
    expect(client.baseURL).toBe(FPT_BASE_URL);
    expect(client.apiKey).toBe('fpt-test-key');
  });

  it('routes fptcloud/ models to the FPT Cloud AI endpoint and strips the prefix', () => {
    process.env.FPT_API_KEY = 'fpt-test-key';
    const p = createProvider({ model: 'fptcloud/GLM-5.2' });
    expect(p.model).toBe('GLM-5.2');
    expect(p.name).toBe('FPT Cloud AI');
    const client = (p as unknown as { client: { baseURL: string; apiKey: string } }).client;
    expect(client.baseURL).toBe(FPT_BASE_URL);
    expect(client.apiKey).toBe('fpt-test-key');
  });

  it('supports FPTCLOUD_API_KEY as fallback', () => {
    delete process.env.FPT_API_KEY;
    process.env.FPTCLOUD_API_KEY = 'fptcloud-fallback-key';
    const p = createProvider({ model: 'fpt/Qwen3.8-27B' });
    const client = (p as unknown as { client: { baseURL: string; apiKey: string } }).client;
    expect(client.apiKey).toBe('fptcloud-fallback-key');
  });

  it('supports custom FPT_BASE_URL override', () => {
    process.env.FPT_API_KEY = 'fpt-key';
    process.env.FPT_BASE_URL = 'https://custom-fpt-gateway.example.com/v1';
    const p = createProvider({ model: 'fpt/gemma-4-31B-it' });
    const client = (p as unknown as { client: { baseURL: string; apiKey: string } }).client;
    expect(client.baseURL).toBe('https://custom-fpt-gateway.example.com/v1');
  });

  it('maps fpt/ and fptcloud/ models to the FPT_API_KEY env var', () => {
    expect(apiKeyEnvVarForModel('fpt/DeepSeek-V4-Flash')).toBe('FPT_API_KEY');
    expect(apiKeyEnvVarForModel('fpt/GLM-5.2')).toBe('FPT_API_KEY');
    expect(apiKeyEnvVarForModel('fpt/Vietnamese_Embedding')).toBe('FPT_API_KEY');
    expect(apiKeyEnvVarForModel('fptcloud/Qwen3.8-27B')).toBe('FPT_API_KEY');
  });

  it('reports the fpt family', () => {
    expect(modelProviderFamily('fpt/DeepSeek-V4-Flash')).toBe('fpt');
    expect(modelProviderFamily('fptcloud/GLM-5.2')).toBe('fpt');
  });

  it('isModelConfigured respects FPT_API_KEY and FPTCLOUD_API_KEY', () => {
    delete process.env.FPT_API_KEY;
    delete process.env.FPTCLOUD_API_KEY;
    expect(isModelConfigured('fpt/DeepSeek-V4-Flash')).toBe(false);
    expect(isModelConfigured('fptcloud/GLM-5.2')).toBe(false);

    process.env.FPT_API_KEY = 'k';
    expect(isModelConfigured('fpt/DeepSeek-V4-Flash')).toBe(true);

    delete process.env.FPT_API_KEY;
    process.env.FPTCLOUD_API_KEY = 'k2';
    expect(isModelConfigured('fptcloud/GLM-5.2')).toBe(true);
  });

  it('resolves context windows from the provider registry', () => {
    expect(getContextWindow('fpt/DeepSeek-V4-Flash')).toBe(500_000);
    expect(getContextWindow('fpt/GLM-5.2')).toBe(1_000_000);
    expect(getContextWindow('fpt/Qwen3.8-27B')).toBe(262_144);
    expect(getContextWindow('fpt/gemma-4-31B-it')).toBe(262_000);
    expect(getContextWindow('fpt/Vietnamese_Embedding')).toBe(8_000);
    expect(getContextWindow('fpt/multilingual-e5-large')).toBe(8_000);
  });

  it('includes FPT models in getAllModels()', () => {
    const models = getAllModels();
    const fptModels = models.filter(m => m.provider === 'FPT Cloud AI');
    expect(fptModels.length).toBeGreaterThanOrEqual(19);
    expect(fptModels.some(m => m.id === 'fpt/DeepSeek-V4-Flash')).toBe(true);
    expect(fptModels.some(m => m.id === 'fpt/Vietnamese_Embedding')).toBe(true);
    expect(fptModels.some(m => m.id === 'fpt/multilingual-e5-large')).toBe(true);
  });
});

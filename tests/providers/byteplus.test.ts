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
  BYTEPLUS_CODING_BASE_URL,
} from '../../src/providers/factory.js';
import { registerCustomProviders } from '../../src/providers/factory.js';

describe('BytePlus ModelArk Coding Plan', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    process.env = { ...orig };
    registerCustomProviders([]);
  });

  it('routes byteplus/ models to the Coding Plan endpoint and strips the prefix', () => {
    process.env.ARK_API_KEY = 'ark-test';
    const p = createProvider({ model: 'byteplus/ark-code-latest' });
    expect(p.model).toBe('ark-code-latest');
    expect(p.name).toBe('BytePlus ModelArk');
    const client = (p as unknown as { client: { baseURL: string; apiKey: string } }).client;
    expect(client.baseURL).toBe(BYTEPLUS_CODING_BASE_URL);
    expect(client.apiKey).toBe('ark-test');
  });

  it('maps byteplus/ models to the ARK_API_KEY env var', () => {
    expect(apiKeyEnvVarForModel('byteplus/dola-seed-2.0-pro')).toBe('ARK_API_KEY');
    expect(apiKeyEnvVarForModel('byteplus/glm-5.2')).toBe('ARK_API_KEY');
  });

  it('reports the byteplus family', () => {
    expect(modelProviderFamily('byteplus/ark-code-latest')).toBe('byteplus');
  });

  it('isModelConfigured respects ARK_API_KEY', () => {
    delete process.env.ARK_API_KEY;
    expect(isModelConfigured('byteplus/ark-code-latest')).toBe(false);
    process.env.ARK_API_KEY = 'k';
    expect(isModelConfigured('byteplus/ark-code-latest')).toBe(true);
  });

  it('resolves a context window from the provider registry', () => {
    expect(getContextWindow('byteplus/ark-code-latest')).toBe(200_000);
    expect(getContextWindow('byteplus/glm-5.2')).toBe(1_000_000);
  });
});

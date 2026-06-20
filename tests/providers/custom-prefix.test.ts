import { describe, it, expect, beforeEach } from 'vitest';
import { registerCustomProviders, createProvider } from '../../src/providers/factory.js';
import type { ProviderDef } from '../../src/config/project-config.js';

describe('custom provider prefixes', () => {
  beforeEach(() => {
    registerCustomProviders([{
      name: 'Xiaomi MiMo',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      apiKeyEnv: 'XIAOMI_API_KEY',
      prefixes: ['mimo-', 'xiaomi/'],
    } satisfies ProviderDef]);
    process.env.XIAOMI_API_KEY = 'test-key';
  });

  it('does not strip mimo- from model id sent to the API', () => {
    const p = createProvider({ model: 'mimo-v2.5-pro' });
    expect(p.model).toBe('mimo-v2.5-pro');
  });

  it('strips deepseek/ vendor prefix', () => {
    registerCustomProviders([{
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      prefixes: ['deepseek/'],
    }]);
    process.env.DEEPSEEK_API_KEY = 'k';
    const p = createProvider({ model: 'deepseek/deepseek-v4-flash' });
    expect(p.model).toBe('deepseek-v4-flash');
  });
});
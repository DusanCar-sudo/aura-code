import { describe, it, expect } from 'vitest';
import { resolveProviderTransport } from '../../src/providers/factory.js';

describe('resolveProviderTransport', () => {
  it('clears MiMo baseUrl when model is DeepSeek', () => {
    const r = resolveProviderTransport('deepseek/deepseek-v4-flash', {
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    });
    expect(r.baseUrl).toBeUndefined();
  });
});
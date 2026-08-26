import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/setup/provider-wizard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/setup/provider-wizard.js')>();
  return {
    ...actual,
    loadProviderConfig: vi.fn(() => null),
  };
});

import { registerCustomProviders, isModelConfigured } from '../../src/providers/factory.js';
import type { ProviderDef } from '../../src/config/project-config.js';

describe('isModelConfigured', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    process.env = { ...orig };
    registerCustomProviders([]);
  });

  it('returns false for mimo when XIAOMI_API_KEY is unset', () => {
    delete process.env.XIAOMI_API_KEY;
    expect(isModelConfigured('mimo-v2.5-pro')).toBe(false);
  });

  it('returns true for deepseek prefix when DEEPSEEK_API_KEY is set', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    expect(isModelConfigured('deepseek/deepseek-v4-flash')).toBe(true);
  });

  it('respects custom provider apiKeyEnv from .aura.json', () => {
    const providers: ProviderDef[] = [{
      name: 'Test',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'TEST_API_KEY',
      prefixes: ['test/'],
    }];
    registerCustomProviders(providers);
    delete process.env.TEST_API_KEY;
    expect(isModelConfigured('test/foo')).toBe(false);
    process.env.TEST_API_KEY = 'k';
    expect(isModelConfigured('test/foo')).toBe(true);
  });

  it('returns true for qwen models when DASHSCOPE_API_KEY or QWEN_API_KEY is set', () => {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.QWEN_API_KEY;
    expect(isModelConfigured('qwen/qwen3-coder-plus')).toBe(false);
    process.env.DASHSCOPE_API_KEY = 'sk-dashscope';
    expect(isModelConfigured('qwen/qwen3-coder-plus')).toBe(true);
  });

  it('returns true for minimax models when MINIMAX_API_KEY is set', () => {
    delete process.env.MINIMAX_API_KEY;
    expect(isModelConfigured('minimax/MiniMax-Text-01')).toBe(false);
    process.env.MINIMAX_API_KEY = 'sk-minimax';
    expect(isModelConfigured('minimax/MiniMax-Text-01')).toBe(true);
  });
});
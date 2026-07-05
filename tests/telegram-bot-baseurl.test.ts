import { describe, it, expect } from 'vitest';
import { resolveTaskModelBaseUrl } from '../src/providers/factory.js';

describe('resolveTaskModelBaseUrl', () => {
  it('reproduces and fixes the original bug: a stale DeepSeek baseUrl must NOT be paired with an OpenCode model', () => {
    // Exact production scenario: globalCfg was saved with model
    // 'deepseek-v4-pro' + DeepSeek's baseUrl, but the bot's task model later
    // resolved to 'opencode/big-pickle' (a different provider entirely).
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      fileConfig: undefined,
      globalCfg: { defaultModel: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' },
    });
    expect(result).toBeUndefined();
  });

  it('trusts globalCfg.baseUrl when its defaultModel matches the task model', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'mimo-v2.5-pro',
      globalCfg: { defaultModel: 'mimo-v2.5-pro', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' },
    });
    expect(result).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
  });

  it('trusts fileConfig.baseUrl when its model matches the task model', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      fileConfig: { model: 'opencode/big-pickle', baseUrl: 'https://opencode.ai/zen/v1' },
    });
    expect(result).toBe('https://opencode.ai/zen/v1');
  });

  it('ignores fileConfig.baseUrl when its model does NOT match the task model', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      fileConfig: { model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' },
      globalCfg: undefined,
    });
    expect(result).toBeUndefined();
  });

  it('AURA_BASE_URL env override always wins, regardless of model matching', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      envBaseUrl: 'https://custom.example.com/v1',
      fileConfig: { model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' },
      globalCfg: { defaultModel: 'something-else', baseUrl: 'https://other.example.com/v1' },
    });
    expect(result).toBe('https://custom.example.com/v1');
  });

  it('prefers fileConfig over globalCfg when both match the task model', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      fileConfig: { model: 'opencode/big-pickle', baseUrl: 'https://file-config.example.com/v1' },
      globalCfg: { defaultModel: 'opencode/big-pickle', baseUrl: 'https://global-config.example.com/v1' },
    });
    expect(result).toBe('https://file-config.example.com/v1');
  });

  it('falls back to globalCfg when fileConfig does not match but globalCfg does', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      fileConfig: { model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' },
      globalCfg: { defaultModel: 'opencode/big-pickle', baseUrl: 'https://opencode.ai/zen/v1' },
    });
    expect(result).toBe('https://opencode.ai/zen/v1');
  });

  it('returns undefined when nothing matches and no env override is set', () => {
    const result = resolveTaskModelBaseUrl({
      taskModel: 'opencode/big-pickle',
      fileConfig: undefined,
      globalCfg: null,
    });
    expect(result).toBeUndefined();
  });

  it('handles missing fileConfig/globalCfg entirely without throwing', () => {
    expect(() => resolveTaskModelBaseUrl({ taskModel: 'claude-sonnet-4-6' })).not.toThrow();
    expect(resolveTaskModelBaseUrl({ taskModel: 'claude-sonnet-4-6' })).toBeUndefined();
  });
});

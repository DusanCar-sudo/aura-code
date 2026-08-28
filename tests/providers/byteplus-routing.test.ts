import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProvider, apiKeyEnvVarForModel } from '../../src/providers/factory.js';

/**
 * BytePlus ModelArk routing.
 *
 * `byteplus/` was documented in README before it routed anywhere — `-m
 * byteplus/<model>` fell through to the generic openai-compatible branch and
 * hit OpenAI with an Ark model id. These tests pin the four things that were
 * wrong: the key env var, the base URL, the prefix strip, and the fact that
 * Ark matches its dated ids case- and character-exactly.
 */
describe('BytePlus ModelArk routing', () => {
  const saved = { key: process.env.ARK_API_KEY, base: process.env.ARK_BASE_URL };
  const GA = 'byteplus/deepseek-v4-flash-ga-260731';

  beforeEach(() => {
    process.env.ARK_API_KEY = 'test-key';
    delete process.env.ARK_BASE_URL;
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.ARK_BASE_URL;
    else process.env.ARK_BASE_URL = saved.base;
  });

  /** The endpoint the provider will actually call, read off its OpenAI client. */
  const endpoint = (p: unknown): string =>
    String((p as { client?: { baseURL?: string } }).client?.baseURL ?? '').replace(/\/+$/, '');

  it('resolves the key from ARK_API_KEY, not OPENAI_API_KEY', () => {
    expect(apiKeyEnvVarForModel(GA)).toBe('ARK_API_KEY');
  });

  it('strips the byteplus/ prefix before the id goes on the wire', () => {
    expect(createProvider({ model: GA }).model).toBe('deepseek-v4-flash-ga-260731');
  });

  it('preserves the dated GA suffix exactly — Ark matches ids character-for-character', () => {
    // A "helpful" normalisation that dropped `-ga-260731` would silently route
    // to a different build, or 404. Pin the whole string.
    expect(createProvider({ model: GA }).model).toMatch(/-ga-\d{6}$/);
  });

  it('targets the international Ark gateway by default', () => {
    expect(endpoint(createProvider({ model: GA })))
      .toBe('https://ark.ap-southeast.bytepluses.com/api/v3');
  });

  it('honours ARK_BASE_URL for a different region, trailing slash and all', () => {
    process.env.ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3/';
    expect(endpoint(createProvider({ model: GA })))
      .toBe('https://ark.cn-beijing.volces.com/api/v3');
  });

  it('reports BytePlus ModelArk as the provider name', () => {
    expect(createProvider({ model: GA }).name).toContain('BytePlus');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createProvider,
  apiKeyEnvVarForModel,
  registerCustomProviders,
} from '../../src/providers/factory.js';

/**
 * The `fpt/` prefix was documented in README and agents.env.example before it
 * routed anywhere — `-m fpt/<model>` fell through to the generic
 * openai-compatible branch and hit OpenAI with an FPT model id. These tests
 * pin the four things that has to get right: the key, the endpoint, the
 * per-account endpoint override, and the id actually sent to the API.
 */
/** The endpoint the provider will actually call, read off its OpenAI client. */
const endpoint = (p: unknown): string =>
  String((p as { client?: { baseURL?: string } }).client?.baseURL ?? '').replace(/\/+$/, '');

describe('FPT Cloud AI routing', () => {
  const saved = { key: process.env.FPT_API_KEY, base: process.env.FPT_BASE_URL };

  beforeEach(() => {
    registerCustomProviders([]);
    process.env.FPT_API_KEY = 'test-key';
    delete process.env.FPT_BASE_URL;
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env.FPT_API_KEY;
    else process.env.FPT_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.FPT_BASE_URL;
    else process.env.FPT_BASE_URL = saved.base;
  });

  it('resolves the key from FPT_API_KEY, not OPENAI_API_KEY', () => {
    expect(apiKeyEnvVarForModel('fpt/DeepSeek-V3')).toBe('FPT_API_KEY');
  });

  it('strips the routing prefix and keeps the id\'s case', () => {
    // createProvider dispatches on a lower-cased copy; marketplace ids are
    // mixed case and the gateway matches them exactly, so the branch has to
    // read the original.
    expect(createProvider({ model: 'fpt/DeepSeek-V3' }).model).toBe('DeepSeek-V3');
  });

  it('defaults to the marketplace endpoint', () => {
    expect(endpoint(createProvider({ model: 'fpt/DeepSeek-V3' })))
      .toBe('https://mkp-api.fptcloud.com/v1');
  });

  it('honours FPT_BASE_URL for a per-account endpoint, trailing slash and all', () => {
    process.env.FPT_BASE_URL = 'https://tenant.fptcloud.com/v1/';
    expect(endpoint(createProvider({ model: 'fpt/DeepSeek-V3' })))
      .toBe('https://tenant.fptcloud.com/v1');
  });
});

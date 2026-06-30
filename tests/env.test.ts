import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getApiKey, getEnv } from '../src/util/env.js';

describe('getApiKey', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.test_key;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('returns canonical UPPER value when set', () => {
    process.env.TEST_KEY = 'upper-value';
    expect(getApiKey('TEST_KEY')).toBe('upper-value');
  });

  it('falls back to lowercase variant when canonical is missing', () => {
    process.env.test_key = 'lower-value';
    expect(getApiKey('TEST_KEY')).toBe('lower-value');
  });

  it('prefers canonical over lowercase when both are set', () => {
    process.env.TEST_KEY = 'upper';
    process.env.test_key = 'lower';
    expect(getApiKey('TEST_KEY')).toBe('upper');
  });

  it('tries aliases in order', () => {
    process.env.TEST_KEY_ALT = 'alt-value';
    expect(getApiKey('TEST_KEY', 'TEST_KEY_ALT')).toBe('alt-value');
  });

  it('returns undefined when nothing is set', () => {
    expect(getApiKey('TEST_KEY')).toBeUndefined();
  });

  it('ignores placeholder values', () => {
    process.env.TEST_KEY = 'your_api_key_here';
    expect(getApiKey('TEST_KEY')).toBeUndefined();
  });

  it('ignores whitespace-only values', () => {
    process.env.TEST_KEY = '   ';
    expect(getApiKey('TEST_KEY')).toBeUndefined();
  });
});

describe('getEnv', () => {
  it('returns value from canonical or lowercase', () => {
    process.env.MY_VAR = 'x';
    expect(getEnv('MY_VAR')).toBe('x');
    delete process.env.MY_VAR;
    process.env.my_var = 'y';
    expect(getEnv('MY_VAR')).toBe('y');
  });

  it('returns undefined when unset', () => {
    expect(getEnv('DEFINITELY_NOT_SET_12345')).toBeUndefined();
  });

  it('returns undefined for empty string (so ?? chains work)', () => {
    process.env.MY_EMPTY = '';
    expect(getEnv('MY_EMPTY')).toBeUndefined();
  });

  it('REGRESSION: factory with unset baseUrl env var must fall through to default', () => {
    // Reproduces the bug where an unset XIAOMI_BASE_URL caused the Xiaomi
    // provider to send requests to api.openai.com instead of xiaomimimo.com.
    delete process.env.XIAOMI_BASE_URL;
    delete process.env.xiaomi_base_url;
    const v = getEnv('XIAOMI_BASE_URL');
    // Caller relies on `??` to fall through to the next default. If we return
    // '' here, the empty string propagates and OpenAI SDK defaults to
    // api.openai.com — which was the original bug.
    expect(v).toBeUndefined();
  });
});

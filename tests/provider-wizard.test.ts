import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PROVIDER_REGISTRY,
  findProviderByName,
  detectExistingKey,
  getSignupUrl,
  maskApiKey,
} from '../src/setup/provider-registry.js';
import type { ProviderEntry } from '../src/setup/provider-registry.js';
import { testProviderConnection } from '../src/setup/provider-test.js';
import { loadProviderConfig } from '../src/setup/provider-wizard.js';

// ─────────────────────────────────────────────────────────────────────────────
// Provider Registry Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PROVIDER_REGISTRY', () => {
  it('contains at least 10 providers', () => {
    expect(PROVIDER_REGISTRY.length).toBeGreaterThanOrEqual(10);
  });

  it('all entries have required fields', () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(entry.name).toBeTruthy();
      expect(typeof entry.baseUrl).toBe('string');
      expect(typeof entry.signupUrl).toBe('string');
      expect(Array.isArray(entry.models)).toBe(true);
      // envKey is string | null
      expect(entry.envKey === null || typeof entry.envKey === 'string').toBe(true);
    }
  });

  it('all models have required fields', () => {
    for (const entry of PROVIDER_REGISTRY) {
      for (const model of entry.models) {
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
        expect(model.speed).toBeTruthy();
        expect(typeof model.contextWindow).toBe('number');
        expect(model.contextWindow).toBeGreaterThan(0);
      }
    }
  });

  it('includes DeepSeek as first provider', () => {
    expect(PROVIDER_REGISTRY[0].name).toBe('DeepSeek');
  });

  it('includes all major providers', () => {
    const names = PROVIDER_REGISTRY.map(p => p.name);
    expect(names).toContain('DeepSeek');
    expect(names).toContain('Anthropic (Claude)');
    expect(names).toContain('OpenAI (GPT)');
    expect(names).toContain('Google (Gemini)');
    expect(names).toContain('Xiaomi MiMo');
    expect(names).toContain('OpenRouter');
    expect(names).toContain('xAI (Grok)');
    expect(names).toContain('NVIDIA NIM');
    expect(names).toContain('Ollama (local, free)');
    expect(names).toContain('Custom endpoint');
  });

  it('Ollama has no API key requirement', () => {
    const ollama = PROVIDER_REGISTRY.find(p => p.name === 'Ollama (local, free)');
    expect(ollama).toBeDefined();
    expect(ollama!.envKey).toBeNull();
    expect(ollama!.models).toEqual([]);
  });

  it('Custom endpoint has empty baseUrl and no models', () => {
    const custom = PROVIDER_REGISTRY.find(p => p.name === 'Custom endpoint');
    expect(custom).toBeDefined();
    expect(custom!.baseUrl).toBe('');
    expect(custom!.envKey).toBeNull();
    expect(custom!.models).toEqual([]);
  });

  it('cloud providers have valid baseUrls', () => {
    const cloudProviders = PROVIDER_REGISTRY.filter(
      p => p.envKey !== null && p.name !== 'Custom endpoint',
    );
    for (const p of cloudProviders) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it('all cloud providers have envKey set', () => {
    const cloudProviders = PROVIDER_REGISTRY.filter(
      p => p.name !== 'Ollama (local, free)' && p.name !== 'Custom endpoint',
    );
    for (const p of cloudProviders) {
      expect(p.envKey).toBeTruthy();
      expect(p.envKey).toMatch(/_API_KEY$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findProviderByName
// ─────────────────────────────────────────────────────────────────────────────

describe('findProviderByName', () => {
  it('finds provider by exact name', () => {
    const result = findProviderByName('DeepSeek');
    expect(result).toBeDefined();
    expect(result!.name).toBe('DeepSeek');
  });

  it('finds provider case-insensitively', () => {
    const result = findProviderByName('deepseek');
    expect(result).toBeDefined();
    expect(result!.name).toBe('DeepSeek');
  });

  it('returns undefined for unknown provider', () => {
    expect(findProviderByName('NonExistent')).toBeUndefined();
  });

  it('finds Anthropic (Claude)', () => {
    const result = findProviderByName('Anthropic (Claude)');
    expect(result).toBeDefined();
    expect(result!.envKey).toBe('ANTHROPIC_API_KEY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Key Detection from Env Vars
// ─────────────────────────────────────────────────────────────────────────────

describe('detectExistingKey', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    // Clear all known provider env vars
    for (const p of PROVIDER_REGISTRY) {
      if (p.envKey) {
        delete process.env[p.envKey];
        delete process.env[p.envKey.toLowerCase()];
      }
    }
  });

  afterEach(() => {
    process.env = { ...orig };
  });

  it('detects key from canonical env var', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-key';
    const deepseek = PROVIDER_REGISTRY.find(p => p.name === 'DeepSeek')!;
    expect(detectExistingKey(deepseek)).toBe('sk-test-deepseek-key');
  });

  it('detects key from lowercase env var', () => {
    process.env.openai_api_key = 'sk-test-openai-key';
    const openai = PROVIDER_REGISTRY.find(p => p.name === 'OpenAI (GPT)')!;
    expect(detectExistingKey(openai)).toBe('sk-test-openai-key');
  });

  it('returns null when no env var is set', () => {
    const anthropic = PROVIDER_REGISTRY.find(p => p.name === 'Anthropic (Claude)')!;
    expect(detectExistingKey(anthropic)).toBeNull();
  });

  it('returns null for providers with no envKey (Ollama)', () => {
    const ollama = PROVIDER_REGISTRY.find(p => p.name === 'Ollama (local, free)')!;
    expect(detectExistingKey(ollama)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Key Masking
// ─────────────────────────────────────────────────────────────────────────────

describe('maskApiKey', () => {
  it('masks long key showing first 4 + last 4', () => {
    expect(maskApiKey('sk-547efg789abcdef1a3')).toBe('sk-5...f1a3');
  });

  it('masks standard API key', () => {
    const masked = maskApiKey('sk-1234567890abcdefghijklmn');
    expect(masked).toBe('sk-1...klmn');
    expect(masked).not.toContain('567890');
  });

  it('returns **** for short keys', () => {
    expect(maskApiKey('short')).toBe('****');
    expect(maskApiKey('12345678')).toBe('****');
  });

  it('handles exactly 10 char key', () => {
    expect(maskApiKey('1234567890')).toBe('1234...7890');
  });

  it('never reveals the full key', () => {
    const key = 'sk-very-secret-api-key-value';
    const masked = maskApiKey(key);
    expect(masked.length).toBeLessThan(key.length);
    expect(masked).not.toBe(key);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSignupUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('getSignupUrl', () => {
  it('returns the signup URL for a provider', () => {
    const deepseek = PROVIDER_REGISTRY.find(p => p.name === 'DeepSeek')!;
    expect(getSignupUrl(deepseek)).toBe('https://platform.deepseek.com/api_keys');
  });

  it('returns empty string for Custom endpoint', () => {
    const custom = PROVIDER_REGISTRY.find(p => p.name === 'Custom endpoint')!;
    expect(getSignupUrl(custom)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection Test (mocked HTTP)
// ─────────────────────────────────────────────────────────────────────────────

describe('testProviderConnection', () => {
  it('returns ok:false when connecting to a non-existent server', async () => {
    const result = await testProviderConnection({
      provider: 'DeepSeek',
      model: 'deepseek-v4-flash',
      baseUrl: 'http://localhost:19999',
      apiKey: 'fake-key',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns ok:false for Ollama when not running', async () => {
    const result = await testProviderConnection({
      provider: 'Ollama (local, free)',
      model: 'llama3.2',
      baseUrl: 'http://localhost:19999/v1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Ollama');
  });

  it('handles Anthropic auth format (x-api-key)', async () => {
    // Should fail with connection error since there's no real server
    const result = await testProviderConnection({
      provider: 'Anthropic (Claude)',
      model: 'claude-sonnet-4-5-20251001',
      baseUrl: 'http://localhost:19999',
      apiKey: 'fake-key',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('handles Google auth format (?key= param)', async () => {
    const result = await testProviderConnection({
      provider: 'Google (Gemini)',
      model: 'gemini-2.5-flash',
      baseUrl: 'http://localhost:19999',
      apiKey: 'fake-key',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Save/Load Round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('config save/load round-trip', () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-wizard-test-'));

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadProviderConfig returns null when no config exists', () => {
    const cfg = loadProviderConfig();
    expect(cfg).toBeNull();
  });

  it('loadProviderConfig loads saved config', () => {
    const configDir = path.join(tmpDir, 'aura-code');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'provider.json'),
      JSON.stringify({
        provider: 'DeepSeek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test-key',
      }),
    );

    const cfg = loadProviderConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe('DeepSeek');
    expect(cfg!.model).toBe('deepseek-v4-flash');
    expect(cfg!.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(cfg!.apiKey).toBe('sk-test-key');
  });

  it('rejects config with missing fields', () => {
    const configDir = path.join(tmpDir, 'aura-code');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'provider.json'),
      JSON.stringify({ provider: '', model: '' }),
    );

    const cfg = loadProviderConfig();
    expect(cfg).toBeNull();
  });
});

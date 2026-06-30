import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasAnyProvider, needsWizard, PROVIDER_CHOICES } from '../src/setup/first-run.js';
import { getApiKey } from '../src/util/env.js';

describe('first-run detection', () => {
  const orig = { ...process.env };
  const origXdg = process.env.XDG_CONFIG_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-test-'));
  beforeEach(() => {
    // Wipe all known provider env vars (both cases)
    for (const p of PROVIDER_CHOICES) {
      if (p.apiKeyEnv) {
        delete process.env[p.apiKeyEnv];
        delete process.env[p.apiKeyEnv.toLowerCase()];
      }
    }
    // Isolate global config from the user's actual home so the test does not
    // depend on (and does not leak state to) ~/.config/aura-code/config.json.
    process.env.XDG_CONFIG_HOME = tmpHome;
  });
  afterEach(() => {
    process.env = { ...orig };
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('hasAnyProvider is false when no key is set', () => {
    expect(hasAnyProvider()).toBe(false);
  });

  it('hasAnyProvider picks up canonical-case env var', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(hasAnyProvider()).toBe(true);
  });

  it('hasAnyProvider picks up lowercase env var', () => {
    process.env.anthropic_api_key = 'sk-test';
    expect(hasAnyProvider()).toBe(true);
  });

  it('needsWizard triggers when no provider is set and no --api-key given', () => {
    expect(needsWizard({})).toBe(true);
  });

  it('needsWizard does NOT trigger when --api-key is given on CLI', () => {
    expect(needsWizard({ cliApiKey: 'cli-supplied-key' })).toBe(false);
  });

  it('needsWizard does NOT trigger when --model is given on CLI', () => {
    expect(needsWizard({ cliModel: 'gpt-4o' })).toBe(false);
  });

  it('needsWizard DOES trigger when only an env var is set (no model picked yet)', () => {
    // The wizard will detect the env key and pre-select that provider,
    // but the user still needs to pick a model.
    process.env.GOOGLE_API_KEY = 'AIza-test';
    expect(needsWizard({})).toBe(true);
  });

  it('needsWizard does NOT trigger when global config exists (model already saved)', () => {
    // Write a fake global config to the test-isolated path
    const xdg = process.env.XDG_CONFIG_HOME!;
    const cfgDir = `${xdg}/aura-code`;
    require('fs').mkdirSync(cfgDir, { recursive: true });
    require('fs').writeFileSync(`${cfgDir}/config.json`, JSON.stringify({
      provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY',
      defaultModel: 'claude-sonnet-4-5-20251001',
      createdAt: 'x', updatedAt: 'x',
    }));
    expect(needsWizard({})).toBe(false);
  });

  it('PROVIDER_CHOICES covers 8 vendors with description + models', () => {
    expect(PROVIDER_CHOICES.length).toBeGreaterThanOrEqual(8);
    for (const p of PROVIDER_CHOICES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.models.length).toBeGreaterThan(0);
      if (p.needsKey) expect(p.apiKeyEnv).toBeTruthy();
    }
  });

  it('PROVIDER_CHOICES includes the major vendors', () => {
    const ids = PROVIDER_CHOICES.map(p => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    expect(ids).toContain('xiaomi');
    expect(ids).toContain('xai');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('ollama');
    expect(ids).toContain('local');
  });

  it('every provider has at least 3 models in its menu', () => {
    for (const p of PROVIDER_CHOICES) {
      expect(p.models.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('regression: getApiKey + provider selection', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    for (const p of PROVIDER_CHOICES) {
      if (p.apiKeyEnv) {
        delete process.env[p.apiKeyEnv];
        delete process.env[p.apiKeyEnv.toLowerCase()];
      }
    }
  });
  afterEach(() => {
    process.env = { ...orig };
  });

  it('lowercase anthropic_api_key is detected by hasAnyProvider', () => {
    process.env.anthropic_api_key = 'sk-test';
    expect(getApiKey('ANTHROPIC_API_KEY')).toBe('sk-test');
    expect(hasAnyProvider()).toBe(true);
  });
});

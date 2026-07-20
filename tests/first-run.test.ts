import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasAnyProvider, needsWizard } from '../src/setup/first-run.js';
import { PROVIDER_REGISTRY } from '../src/setup/provider-registry.js';
import { getApiKey } from '../src/util/env.js';

function wipeProviderEnv(): void {
  for (const p of PROVIDER_REGISTRY) {
    if (p.envKey) {
      delete process.env[p.envKey];
      delete process.env[p.envKey.toLowerCase()];
    }
  }
}

describe('first-run detection', () => {
  const orig = { ...process.env };
  const origXdg = process.env.XDG_CONFIG_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  beforeEach(() => {
    wipeProviderEnv();
    // Isolate global config from the user's actual home so the test does not
    // depend on (and does not leak state to) ~/.config/aura-code/config.json.
    process.env.XDG_CONFIG_HOME = tmpHome;
  });
  afterEach(() => {
    process.env = { ...orig };
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.mkdirSync(tmpHome, { recursive: true });
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
    const cfgDir = path.join(process.env.XDG_CONFIG_HOME!, 'aura-code');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
      provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY',
      defaultModel: 'claude-sonnet-4-5-20251001',
      createdAt: 'x', updatedAt: 'x',
    }));
    expect(needsWizard({})).toBe(false);
  });

  it('needsWizard does NOT trigger when a wizard provider.json exists (keyless providers)', () => {
    const cfgDir = path.join(process.env.XDG_CONFIG_HOME!, 'aura-code');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'provider.json'), JSON.stringify({
      provider: 'Ollama (local, free)', model: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
    }));
    expect(needsWizard({})).toBe(false);
  });

  it('PROVIDER_REGISTRY entries are well-formed', () => {
    expect(PROVIDER_REGISTRY.length).toBeGreaterThanOrEqual(8);
    const names = new Set<string>();
    for (const p of PROVIDER_REGISTRY) {
      expect(p.name).toBeTruthy();
      expect(names.has(p.name)).toBe(false); // no duplicate provider entries
      names.add(p.name);
      for (const m of p.models) {
        expect(m.id).toBeTruthy();
        expect(m.contextWindow).toBeGreaterThan(0);
      }
    }
  });

  it('a model id resolves to ONE context window across the registry', () => {
    const windows = new Map<string, number>();
    for (const p of PROVIDER_REGISTRY) {
      for (const m of p.models) {
        const seen = windows.get(m.id);
        if (seen !== undefined) expect(seen).toBe(m.contextWindow);
        windows.set(m.id, m.contextWindow);
      }
    }
  });
});

describe('regression: getApiKey + provider selection', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    wipeProviderEnv();
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

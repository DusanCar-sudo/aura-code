import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadGlobalConfig, saveGlobalConfig, globalConfigPath } from '../src/setup/global-config.js';

describe('global-config', () => {
  let tmpHome: string;
  let origXdg: string | undefined;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
    origXdg = process.env.XDG_CONFIG_HOME;
    origHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = tmpHome;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns null when no config exists', () => {
    expect(loadGlobalConfig()).toBeNull();
  });

  it('saves and loads a config', () => {
    const saved = saveGlobalConfig({
      provider: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      defaultModel: 'claude-sonnet-4-5-20251001',
    });
    expect(saved.provider).toBe('anthropic');
    expect(saved.defaultModel).toBe('claude-sonnet-4-5-20251001');
    expect(saved.createdAt).toBeTruthy();
    expect(saved.updatedAt).toBeTruthy();
    expect(fs.existsSync(globalConfigPath())).toBe(true);
    const reloaded = loadGlobalConfig();
    expect(reloaded?.provider).toBe('anthropic');
  });

  it('preserves createdAt across updates', () => {
    const first = saveGlobalConfig({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' });
    const second = saveGlobalConfig({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
  });

  it('keeps the effort rung across a model switch that does not carry it', () => {
    // trySetModel rewrites this file without an effort field; dropping it there
    // would silently reset the user to the provider default on every switch.
    saveGlobalConfig({
      provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek/deepseek-v4-flash', effort: 'max',
    });
    const afterSwitch = saveGlobalConfig({
      provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek/deepseek-v4-pro',
    });
    expect(afterSwitch.effort).toBe('max');
    expect(loadGlobalConfig()?.effort).toBe('max');
  });

  it('omits effort entirely when it was never set', () => {
    saveGlobalConfig({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' });
    const raw = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8'));
    expect('effort' in raw).toBe(false);
  });

  it('rejects malformed config (missing required fields)', () => {
    fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
    fs.writeFileSync(globalConfigPath(), JSON.stringify({ provider: 'openai' }));
    expect(loadGlobalConfig()).toBeNull();
  });
});

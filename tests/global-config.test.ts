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
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-test-'));
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

  it('rejects malformed config (missing required fields)', () => {
    fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
    fs.writeFileSync(globalConfigPath(), JSON.stringify({ provider: 'openai' }));
    expect(loadGlobalConfig()).toBeNull();
  });
});

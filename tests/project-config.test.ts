import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadProjectConfig, resolveConfig } from '../src/config/project-config.js';

describe('loadProjectConfig', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-cfg-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('returns empty when no .aura.json', () => {
    expect(loadProjectConfig(tmpDir)).toEqual({});
  });

  it('loads valid config from project root', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({
      model: 'gpt-4o',
      mode: 'auto',
      ignore: ['vendor/'],
    }));
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.mode).toBe('auto');
    expect(cfg.ignore).toEqual(['vendor/']);
  });

  it('walks up to find ancestor config', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({ model: 'haiku' }));
    const subdir = path.join(tmpDir, 'a', 'b');
    fs.mkdirSync(subdir, { recursive: true });
    const cfg = loadProjectConfig(subdir);
    expect(cfg.model).toBe('haiku');
  });

  it('silently returns empty on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), '{not json');
    expect(loadProjectConfig(tmpDir)).toEqual({});
  });

  it('rejects invalid mode values', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({ mode: 'nuclear' }));
    expect(loadProjectConfig(tmpDir).mode).toBeUndefined();
  });
});

describe('resolveConfig', () => {
  it('CLI args override file', () => {
    const out = resolveConfig(
      { model: 'file-model', mode: 'normal' },
      { model: 'cli-model' },
      { model: 'default', mode: 'normal', ignore: [] },
    );
    expect(out.model).toBe('cli-model');
  });

  it('file config beats defaults', () => {
    const out = resolveConfig(
      { model: 'file-model' },
      {},
      { model: 'default', mode: 'normal', ignore: [] },
    );
    expect(out.model).toBe('file-model');
  });

  it('--auto flag sets mode to auto', () => {
    const out = resolveConfig({}, { auto: true }, { model: 'x', mode: 'normal', ignore: [] });
    expect(out.mode).toBe('auto');
  });

  it('--readonly flag sets mode to read-only', () => {
    const out = resolveConfig({}, { readonly: true }, { model: 'x', mode: 'normal', ignore: [] });
    expect(out.mode).toBe('read-only');
  });

  it('ignore lists are concatenated', () => {
    const out = resolveConfig(
      { ignore: ['b'] },
      { ignore: ['c'] },
      { model: 'x', mode: 'normal', ignore: ['a'] },
    );
    expect(out.ignore).toEqual(['a', 'b', 'c']);
  });

  it('passes through providers from file config', () => {
    const providers = [{
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      prefixes: ['deepseek/'],
      models: [{ id: 'deepseek/chat', name: 'Chat', speed: 'Fast' }],
    }];
    const out = resolveConfig(
      { providers },
      {},
      { model: 'x', mode: 'normal', ignore: [] },
    );
    expect(out.providers).toEqual(providers);
  });

  it('defaults providers to empty array', () => {
    const out = resolveConfig({}, {}, { model: 'x', mode: 'normal', ignore: [] });
    expect(out.providers).toEqual([]);
  });
});

describe('loadProjectConfig — providers', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-cfg-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('parses valid providers array', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({
      providers: [{
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        prefixes: ['deepseek/'],
        models: [{ id: 'deepseek/chat', name: 'Chat', speed: 'Fast' }],
      }],
    }));
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers![0].name).toBe('DeepSeek');
    expect(cfg.providers![0].prefixes).toEqual(['deepseek/']);
    expect(cfg.providers![0].models).toEqual([{ id: 'deepseek/chat', name: 'Chat', speed: 'Fast' }]);
  });

  it('skips malformed provider entries', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({
      providers: [
        { name: 'Good', baseUrl: 'https://good.example.com/v1', prefixes: ['good/'] },
        { name: 'MissingBaseUrl' },               // no baseUrl
        'not-an-object',                            // string
        { baseUrl: 'x', prefixes: ['x'] },        // no name
      ],
    }));
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers![0].name).toBe('Good');
  });

  it('skips providers with non-string prefix entries', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({
      providers: [{
        name: 'Test',
        baseUrl: 'https://test.example.com/v1',
        prefixes: ['ok/', 123 as unknown],
      }],
    }));
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers![0].prefixes).toEqual(['ok/']);
  });

  it('handles missing models array gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, '.aura.json'), JSON.stringify({
      providers: [{
        name: 'NoModels',
        baseUrl: 'https://no-models.example.com/v1',
        prefixes: ['nm/'],
      }],
    }));
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers![0].models).toBeUndefined();
  });
});

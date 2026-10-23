import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { githubAppConfig, isGitHubAppConfigured } from '../../src/integrations/github-app.js';

const ID = 'GITHUB_APP_ID';
const KEY = 'GITHUB_APP_PRIVATE_KEY';
const INST = 'GITHUB_APP_INSTALLATION_ID';

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved[ID] = process.env[ID];
  saved[KEY] = process.env[KEY];
  saved[INST] = process.env[INST];
  delete process.env[ID];
  delete process.env[KEY];
  delete process.env[INST];
});

afterEach(() => {
  for (const k of [ID, KEY, INST]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('github-app config', () => {
  it('is unconfigured when the env vars are absent', () => {
    expect(githubAppConfig()).toBeNull();
    expect(isGitHubAppConfigured()).toBe(false);
  });

  it('is unconfigured when only the app id is present', () => {
    process.env[ID] = '123456';
    expect(githubAppConfig()).toBeNull();
  });

  it('rejects a private key without PEM armor', () => {
    process.env[ID] = '123456';
    process.env[KEY] = 'not-a-pem';
    expect(githubAppConfig()).toBeNull();
  });

  it('normalizes "\\n" literals to real newlines and parses the app id', () => {
    process.env[ID] = '123456';
    process.env[KEY] = '-----BEGIN RSA PRIVATE KEY-----\\nLINE1\\nLINE2\\n-----END RSA PRIVATE KEY-----';
    const cfg = githubAppConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.appId).toBe('123456');
    expect(cfg!.privateKey).toContain('\n');
    expect(cfg!.privateKey).not.toContain('\\n');
    expect(cfg!.installationId).toBeUndefined();
  });

  it('parses an explicit installation id when numeric', () => {
    process.env[ID] = '123456';
    process.env[KEY] = '-----BEGIN RSA PRIVATE KEY-----\\nX\\n-----END RSA PRIVATE KEY-----';
    process.env[INST] = '42';
    expect(githubAppConfig()!.installationId).toBe(42);
  });

  it('ignores a non-numeric installation id', () => {
    process.env[ID] = '123456';
    process.env[KEY] = '-----BEGIN RSA PRIVATE KEY-----\\nX\\n-----END RSA PRIVATE KEY-----';
    process.env[INST] = 'abc';
    expect(githubAppConfig()!.installationId).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// key-store keeps module state (the applied mtime, the superseded map), so
// each test imports a fresh copy against its own AURA_HOME.
let home: string;
const NAME = 'AURA_TEST_KEYSTORE_API_KEY';

async function freshStore() {
  vi.resetModules();
  return import('../../src/setup/key-store.js');
}

function writeStore(map: Record<string, string>, mtimeSec: number): void {
  const p = path.join(home, 'keys.json');
  fs.writeFileSync(p, JSON.stringify(map));
  fs.utimesSync(p, mtimeSec, mtimeSec);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-keystore-'));
  vi.stubEnv('AURA_HOME', home);
  vi.stubEnv('AURA_KEYS_ENV_WINS', '');
  delete process.env[NAME];
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env[NAME];
  fs.rmSync(home, { recursive: true, force: true });
});

describe('key-store', () => {
  it('a saved key beats a stale value inherited from the shell', async () => {
    process.env[NAME] = 'old-from-bashrc';
    writeStore({ [NAME]: 'new-saved' }, 1_000);
    const ks = await freshStore();

    ks.loadKeysIntoEnv();

    expect(process.env[NAME]).toBe('new-saved');
    // A provider built before the load maps its stale key to the new one.
    expect(ks.currentKey('old-from-bashrc')).toBe('new-saved');
  });

  it('AURA_KEYS_ENV_WINS=1 keeps a per-run override', async () => {
    vi.stubEnv('AURA_KEYS_ENV_WINS', '1');
    process.env[NAME] = 'per-run';
    writeStore({ [NAME]: 'saved' }, 1_000);
    const ks = await freshStore();

    ks.loadKeysIntoEnv();

    expect(process.env[NAME]).toBe('per-run');
  });

  it('a running session picks up a key another session saved', async () => {
    writeStore({ [NAME]: 'first' }, 1_000);
    const ks = await freshStore();
    ks.loadKeysIntoEnv();
    expect(process.env[NAME]).toBe('first');

    // Another process rewrites the file.
    writeStore({ [NAME]: 'second' }, 2_000);

    expect(ks.currentKey('first')).toBe('second');
    expect(process.env[NAME]).toBe('second');
  });

  it('a revert does not leave a cycle', async () => {
    writeStore({ [NAME]: 'a' }, 1_000);
    const ks = await freshStore();
    ks.loadKeysIntoEnv();
    writeStore({ [NAME]: 'b' }, 2_000);
    ks.refreshKeysFromStore();
    writeStore({ [NAME]: 'a' }, 3_000);

    expect(ks.currentKey('b')).toBe('a');
    expect(ks.currentKey('a')).toBe('a');
  });

  it('refresh is inert until loadKeysIntoEnv runs', async () => {
    writeStore({ [NAME]: 'stored' }, 1_000);
    const ks = await freshStore();

    ks.refreshKeysFromStore();

    expect(process.env[NAME]).toBeUndefined();
  });
});

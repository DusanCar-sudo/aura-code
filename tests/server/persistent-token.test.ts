import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreatePersistentToken } from '../../src/server/index.js';

/**
 * The server used to mint a fresh random token every run, so a browser tab or
 * a saved `?token=` link stopped working the moment the server restarted —
 * "Unauthorized: missing or invalid token". The token is now persisted per
 * machine-user and reused across runs.
 */
describe('loadOrCreatePersistentToken', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-token-'));
    file = path.join(dir, 'nested', 'server-token');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('mints a hex token and persists it, creating parent dirs', () => {
    const t = loadOrCreatePersistentToken(file);
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(t);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('returns the same token on the next run', () => {
    const first = loadOrCreatePersistentToken(file);
    const second = loadOrCreatePersistentToken(file);
    expect(second).toBe(first);
  });

  it('replaces a garbage file rather than trusting it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-a-token\n');
    const t = loadOrCreatePersistentToken(file);
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(t);
  });

  it('still returns a usable token when the path cannot be written', () => {
    // A path whose parent is a file, not a directory — mkdir will throw.
    const blocked = path.join(dir, 'blocker');
    fs.writeFileSync(blocked, 'x');
    const t = loadOrCreatePersistentToken(path.join(blocked, 'server-token'));
    expect(t).toMatch(/^[0-9a-f]{48}$/);
  });
});

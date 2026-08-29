import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cacheIsStale, compareVersions, isUpdateAvailable, pendingUpdateNotice,
  readUpdateCache, updateCachePath, updateCheckEnabled, UPDATE_TTL_MS,
} from '../../src/util/update-check.js';

let home: string;
const prev = process.env.AURA_HOME;
const prevCi = process.env.CI;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-update-'));
  process.env.AURA_HOME = home;
  delete process.env.CI;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AURA_HOME; else process.env.AURA_HOME = prev;
  if (prevCi === undefined) delete process.env.CI; else process.env.CI = prevCi;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const cache = (latest: string, checkedAt = Date.now()) => {
  fs.mkdirSync(path.dirname(updateCachePath()), { recursive: true });
  fs.writeFileSync(updateCachePath(), JSON.stringify({ checkedAt, latest }));
};

describe('comparing versions', () => {
  it('compares numerically, not as text', () => {
    // The case that matters: as strings "0.9.0" > "0.16.0", so a string compare
    // goes silent on exactly the release the user most needs to hear about.
    expect(compareVersions('0.16.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.16.0')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('handles a missing segment and a leading v', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.3.0', '1.2.9')).toBe(1);
  });

  it('sorts a prerelease below the release it precedes', () => {
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBe(1);
  });
});

describe('deciding whether to say anything', () => {
  it('announces only a genuinely newer version', () => {
    expect(isUpdateAvailable('0.16.0', '0.17.0')).toBe(true);
    expect(isUpdateAvailable('0.16.0', '0.16.0')).toBe(false);
  });

  it('stays quiet when the registry is behind the local build', () => {
    // Exactly the state this repo is in: 0.16.0 built locally, 0.15.5 on npm
    // because the publish workflow was blocked. Telling the developer to
    // "update" to an older version is worse than saying nothing.
    expect(isUpdateAvailable('0.16.0', '0.15.5')).toBe(false);
  });
});

describe('the startup notice', () => {
  it('is a single actionable line naming both versions', () => {
    cache('0.17.0');
    const notice = pendingUpdateNotice('0.16.0');
    expect(notice).toContain('0.17.0');
    expect(notice).toContain('0.16.0');
    expect(notice).toContain('npm install -g aura-code');
  });

  it('says nothing without a cache — the first run never blocks to ask', () => {
    expect(pendingUpdateNotice('0.16.0')).toBeNull();
  });

  it('says nothing when up to date', () => {
    cache('0.16.0');
    expect(pendingUpdateNotice('0.16.0')).toBeNull();
  });

  it('survives a corrupt cache rather than failing a startup', () => {
    fs.mkdirSync(path.dirname(updateCachePath()), { recursive: true });
    fs.writeFileSync(updateCachePath(), 'not json at all');
    expect(readUpdateCache()).toBeNull();
    expect(pendingUpdateNotice('0.16.0')).toBeNull();
  });

  it('can be turned off, and is off in CI', () => {
    cache('0.17.0');
    expect(pendingUpdateNotice('0.16.0', { AURA_NO_UPDATE_CHECK: '1' })).toBeNull();
    expect(pendingUpdateNotice('0.16.0', { CI: 'true' })).toBeNull();
    expect(updateCheckEnabled({})).toBe(true);
  });
});

describe('cache freshness', () => {
  it('treats a missing or expired cache as stale', () => {
    const now = Date.now();
    expect(cacheIsStale(null, now)).toBe(true);
    expect(cacheIsStale({ checkedAt: now - UPDATE_TTL_MS - 1, latest: '1.0.0' }, now)).toBe(true);
    expect(cacheIsStale({ checkedAt: now - 1000, latest: '1.0.0' }, now)).toBe(false);
  });
});

/**
 * "There's a newer Aura" — decided locally, fetched in the background.
 *
 * Two rules shape this, and both come from the same place: a version notice is
 * the least important thing a CLI does, so it must never cost the user
 * anything.
 *
 *   It never delays startup. The banner is drawn from a cache file that is read
 *   synchronously; the network call that refreshes it happens after, detached,
 *   and its result is only ever seen on a later run. A check that made every
 *   launch wait on api-something.com would be worse than no check.
 *
 *   It never nags. One line, once, and only when the published version is
 *   genuinely newer.
 *
 * The source is the npm registry rather than GitHub releases. Users install
 * with `npm install -g aura-code`, so npm is what "is there an update" actually
 * means for them — and the previous GitHub check pointed at a stale mirror
 * (milodule3-debug/aura-code, last release v0.10.3) which would have told
 * everyone on 0.16.0 that they were behind.
 */

import * as fs from 'fs';
import * as path from 'path';

import { auraPath } from './aura-home.js';

/** Where the last answer is kept. */
export function updateCachePath(): string {
  return auraPath('update-check.json');
}

export interface UpdateCache {
  /** Epoch ms of the last successful fetch. */
  checkedAt: number;
  /** The version npm reported. */
  latest: string;
}

/** How long an answer stays good. A release is not urgent news. */
export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Compare two dotted versions. -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Numeric segment by segment, because string comparison gets this exactly
 * backwards where it matters most: "0.9.0" > "0.16.0" as text, so a
 * string-compare check goes quiet on the release the user most needs.
 *
 * A prerelease suffix (`1.2.0-rc.1`) sorts *below* the release it precedes,
 * per semver, so an rc never advertises itself as newer than the final.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: pre ?? '',
    };
  };
  const left = parse(a);
  const right = parse(b);

  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Same numbers: a version with a prerelease tag is the earlier one.
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

/** True when `latest` is a version worth telling the user about. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * Whether the check is allowed to run at all.
 *
 * `AURA_NO_UPDATE_CHECK` turns it off outright, and CI is opted out by default:
 * a build machine cannot act on the notice, and a pipeline reaching the npm
 * registry on every invocation is a surprise nobody asked for.
 */
export function updateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AURA_NO_UPDATE_CHECK) return false;
  if (env.CI) return false;
  return true;
}

/** The cached answer, or null. Never throws — a bad cache is not an error. */
export function readUpdateCache(): UpdateCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(updateCachePath(), 'utf8')) as UpdateCache;
    if (typeof raw?.latest !== 'string' || typeof raw?.checkedAt !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeUpdateCache(cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(updateCachePath()), { recursive: true });
    fs.writeFileSync(updateCachePath(), JSON.stringify(cache) + '\n');
  } catch { /* the cache is an optimisation; failing to write one is not news */ }
}

/** True when the cache is missing or older than the TTL. */
export function cacheIsStale(cache: UpdateCache | null, now = Date.now()): boolean {
  return !cache || now - cache.checkedAt >= UPDATE_TTL_MS;
}

/**
 * Ask npm what the latest published version is, and cache it.
 *
 * Resolves to the version or null. Never rejects, and never logs: this runs
 * unattended behind a real session, and a DNS hiccup must not put a stack trace
 * in the middle of somebody's work.
 */
export async function fetchLatestVersion(timeoutMs = 3000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch('https://registry.npmjs.org/aura-code/latest', {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'aura-cli' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    if (typeof data?.version !== 'string') return null;
    writeUpdateCache({ checkedAt: Date.now(), latest: data.version });
    return data.version;
  } catch {
    return null;
  }
}

/**
 * The notice to print at startup, or null.
 *
 * Reads only the cache, so it costs a single small file read. The first run
 * after a release therefore says nothing and refreshes quietly; the next one
 * tells you. That delay is the price of never making anyone wait on a network
 * call to see their prompt, and it is the right trade for news that keeps.
 */
export function pendingUpdateNotice(current: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!updateCheckEnabled(env)) return null;
  const cache = readUpdateCache();
  if (!cache || !isUpdateAvailable(current, cache.latest)) return null;
  return `Aura ${cache.latest} is available — you have ${current}. Update with: npm install -g aura-code`;
}

/**
 * Refresh the cache in the background if it is stale.
 *
 * Deliberately not awaited by callers. The promise is unref'd through the
 * fetch's own timeout rather than held open, so a slow registry cannot keep the
 * process alive after the user's work is done.
 */
export function refreshUpdateCacheInBackground(env: NodeJS.ProcessEnv = process.env): void {
  if (!updateCheckEnabled(env)) return;
  if (!cacheIsStale(readUpdateCache())) return;
  void fetchLatestVersion();
}

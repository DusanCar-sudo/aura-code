/**
 * versionCheck.ts — Praktess / Aura
 *
 * Runs at session startup. Hits GitHub releases API, compares against
 * the local package.json version, prints a one-line banner if a newer
 * version exists. Fully async and non-blocking — if the check fails for
 * any reason (no network, rate limit, GitHub down) the session starts
 * normally with zero noise.
 *
 * Hook it in the startup sequence AFTER the main banner prints:
 *
 *   import { checkForUpdate } from './versionCheck.js';
 *   await checkForUpdate();          // non-blocking, swallows all errors
 *
 * Designed to be read and modified by a new team member in < 10 minutes.
 */

import path from "node:path";
import process from "node:process";

// ── Config ────────────────────────────────────────────────────────────────────

const REPO = "milodule3-debug/aura-code";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const TIMEOUT_MS = 4_000; // silent fail after this; never delay the session
const CHECK_INTERVAL_HOURS = 6; // don't hammer the API on every restart
const CACHE_FILE = path.join(
  process.env.HOME ?? "~",
  ".aura",
  "update-cache.json",
);

// ── Semver helpers ────────────────────────────────────────────────────────────

/**
 * Parse "v0.3.0" or "0.3.0" → [major, minor, patch].
 * Returns null if the string isn't a recognisable semver.
 */
function parseSemver(raw: string): [number, number, number] | null {
  const match = raw.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/** Returns true if `remote` is strictly newer than `local`. */
function isNewer(local: string, remote: string): boolean {
  const l = parseSemver(local);
  const r = parseSemver(remote);
  if (!l || !r) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false; // equal
}

// ── Cache: avoid hitting the API on every single startup ─────────────────────

interface UpdateCache {
  checkedAt: number;   // epoch ms
  latestTag: string;
  releaseNotes: string;
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

async function writeCache(data: UpdateCache): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* non-critical — just means we'll re-check next time */
  }
}

function isCacheFresh(cache: UpdateCache): boolean {
  const ageMs = Date.now() - cache.checkedAt;
  return ageMs < CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
}

// ── GitHub fetch ──────────────────────────────────────────────────────────────

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string; // release notes markdown
  html_url: string;
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "aura-code-version-check/1.0",
        // No auth token needed for public repo at 100-user scale.
        // If you hit rate limits (60 req/hr per IP), add:
        //   Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
      },
    });
    if (!res.ok) return null; // 404 (no releases yet), 403 (rate limit), etc.
    return (await res.json()) as GitHubRelease;
  } catch {
    return null; // network error, timeout, JSON parse failure — all silent
  } finally {
    clearTimeout(timer);
  }
}

// ── Local version ─────────────────────────────────────────────────────────────

function getLocalVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(__dirname, "../package.json")) as { version: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Banner ────────────────────────────────────────────────────────────────────

const RUBY_RED = "\x1b[38;2;155;17;30m";
const GOLD = "\x1b[38;2;212;175;55m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function printUpdateBanner(localVersion: string, latestTag: string, notes: string): void {
  // Extract first non-empty line of release notes as the "what's new" teaser.
  const teaser = notes
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0 && !l.startsWith("<!--"))
    ?? "See release notes for details.";

  const short = teaser.length > 72 ? teaser.slice(0, 71) + "…" : teaser;

  console.log(
    `\n  ${RUBY_RED}${BOLD}⚡ Update available:${RESET} ` +
    `${DIM}v${localVersion}${RESET} → ${GOLD}${BOLD}${latestTag}${RESET}`,
  );
  console.log(`  ${DIM}${short}${RESET}`);
  console.log(
    `  ${DIM}Run: ${RESET}npm update -g aura-code` +
    `  ${DIM}or:${RESET}  npx aura-code@latest\n`,
  );
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Call once at session startup. Resolves quickly (cache hit) or after a
 * short network round-trip. Never throws — all errors are swallowed so a
 * failed version check never breaks a session.
 */
export async function checkForUpdate(): Promise<void> {
  try {
    const localVersion = getLocalVersion();
    let latestTag: string;
    let releaseNotes: string;

    // Try cache first.
    const cache = await readCache();
    if (cache && isCacheFresh(cache)) {
      latestTag = cache.latestTag;
      releaseNotes = cache.releaseNotes;
    } else {
      // Fetch from GitHub.
      const release = await fetchLatestRelease();
      if (!release) return; // network unavailable — silent
      latestTag = release.tag_name;
      releaseNotes = release.body ?? "";
      await writeCache({ checkedAt: Date.now(), latestTag, releaseNotes });
    }

    if (isNewer(localVersion, latestTag)) {
      printUpdateBanner(localVersion, latestTag, releaseNotes);
    }
  } catch {
    // Last-resort catch: nothing should escape, but if it does, stay silent.
  }
}

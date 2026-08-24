/**
 * Locating a Chrome/Chromium binary for headless rendering.
 *
 * Extracted because two copies had already diverged, each holding half the
 * answer: tools/browser.ts resolved symlinks (Puppeteer needs a real
 * executable path, not a wrapper link) but had no direct-path fallback, while
 * tools/video-render.ts had the fallbacks but returned the unresolved path and
 * threw rather than reporting absence. A third copy for the document renderer
 * would have picked one half arbitrarily.
 *
 * Returns null rather than throwing. Chrome missing is a normal condition on a
 * server or a fresh container, and the caller is the only one that knows
 * whether that is fatal — a PDF render cannot proceed, but a doctor check just
 * wants to say so.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';

/** Checked before anything else. PUPPETEER_EXECUTABLE_PATH is the convention
 *  Puppeteer itself uses, so honouring it means an existing Docker or CI setup
 *  works here without a second variable to discover. */
const ENV_VARS = ['AURA_CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH'];

/** Stable channels before beta/dev: a machine with both installed almost always
 *  means stable is the one being used for real work. */
const COMMANDS = [
  'google-chrome-stable',
  'google-chrome',
  'chromium-browser',
  'chromium',
  'chrome',
];

const DIRECT_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

let cached: string | null | undefined;

/**
 * Absolute path to a usable Chrome, or null when none is installed.
 * Memoised: this shells out several times on a miss, and the answer cannot
 * change within a process in any way that matters.
 */
export function findChrome(): string | null {
  if (cached !== undefined) return cached;
  cached = locate();
  return cached;
}

/** Test seam — forget the memoised answer. */
export function resetChromeCache(): void {
  cached = undefined;
}

function locate(): string | null {
  for (const v of ENV_VARS) {
    const p = process.env[v];
    if (p && fs.existsSync(p)) return realPath(p);
  }

  for (const cmd of COMMANDS) {
    try {
      const resolved = execFileSync('which', [cmd], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (resolved) return realPath(resolved);
    } catch {
      // not on PATH — try the next candidate
    }
  }

  for (const p of DIRECT_PATHS) {
    if (fs.existsSync(p)) return realPath(p);
  }

  return null;
}

/**
 * Follow symlinks to the real executable. Distribution packages install
 * /usr/bin/google-chrome as a link to a wrapper script, and Puppeteer wants
 * what it points at; falls back to the original path if resolution fails,
 * since a working link beats no answer.
 */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** One place to phrase the failure, so every caller says the same actionable
 *  thing instead of surfacing a spawn ENOENT. */
export const CHROME_MISSING_MESSAGE =
  'Chrome or Chromium is required for rendering and was not found. '
  + 'Install google-chrome or chromium, or set AURA_CHROME_PATH to the executable.';

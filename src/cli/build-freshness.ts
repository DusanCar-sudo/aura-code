/**
 * build-freshness.ts — warn when dist/ is older than src/.
 *
 * The CLI runs from dist/ (package.json "bin" points at dist/cli/index.js),
 * but every other signal a developer checks reads src/: `npm test` runs
 * vitest against src/, and `tsc --noEmit` typechecks src/ without emitting.
 * Both pass on a source tree whose compiled output is hours stale, so an
 * edit can look landed and verified while the binary still runs the old
 * code — the failure mode is silent, and the natural response (edit again,
 * re-run the tests) reinforces it.
 *
 * So compare the newest mtime under src/ against the newest under dist/ and
 * say so. This only ever prints; it never blocks or rebuilds, because a
 * stale dist/ is sometimes deliberate (bisecting, comparing against a build,
 * running one command while a long edit is in progress).
 *
 * Installed copies ship dist/ with no src/ beside it (see package.json
 * "files"), so there is nothing to compare and this is a no-op.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories never worth walking — none of them feed the TypeScript build. */
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__']);

export interface StalenessReport {
  /** Newest source file, relative to the package root. */
  newestSource: string;
  /** How far ahead of the build that file is. */
  behindBy: string;
}

/** Newest mtime under `dir` among files matching `ext`, with the file that set it. */
function newestFile(dir: string, ext: string): { mtimeMs: number; file: string } | null {
  let best: { mtimeMs: number; file: string } | null = null;

  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — not worth failing a startup check over
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.name.endsWith(ext)) continue;
      try {
        const { mtimeMs } = fs.statSync(full);
        if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, file: full };
      } catch {
        // raced with a delete; skip it
      }
    }
  };

  walk(dir);
  return best;
}

/** "3m", "2h", "4d" — enough to tell "just now" from "yesterday". */
function humanizeGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Report how far dist/ trails src/, or null when it doesn't (or when there's
 * no src/ to compare against — an installed package). Never throws: a broken
 * freshness check must not be able to stop the CLI from starting.
 *
 * `root` is the package root, i.e. the parent of both src/ and dist/.
 */
export function checkBuildFreshness(root: string): StalenessReport | null {
  try {
    const srcDir = path.join(root, 'src');
    const distDir = path.join(root, 'dist');
    if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return null;

    const source = newestFile(srcDir, '.ts');
    const build = newestFile(distDir, '.js');
    if (!source || !build) return null;

    // A second of slack: tsc stamps its output as it writes, so the last file
    // emitted by a build that started after the last edit can still land a
    // hair behind on a coarse filesystem clock.
    const gap = source.mtimeMs - build.mtimeMs;
    if (gap <= 1_000) return null;

    return {
      newestSource: path.relative(root, source.file),
      behindBy: humanizeGap(gap),
    };
  } catch {
    return null;
  }
}

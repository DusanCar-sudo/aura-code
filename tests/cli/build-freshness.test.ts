import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuildFreshness } from '../../src/cli/build-freshness.js';

const roots: string[] = [];

/**
 * Build a throwaway package root. `srcAge`/`distAge` are minutes in the past,
 * so a *smaller* srcAge means src/ is newer — i.e. the build is stale.
 */
function makeRoot(opts: {
  srcAge?: number;
  distAge?: number;
  noSrc?: boolean;
  noDist?: boolean;
  nested?: boolean;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-freshness-'));
  roots.push(root);
  const now = Date.now();
  const stamp = (file: string, minutesAgo: number) => {
    const when = new Date(now - minutesAgo * 60_000);
    fs.utimesSync(file, when, when);
  };

  if (!opts.noSrc) {
    const dir = opts.nested ? path.join(root, 'src', 'cli', 'deep') : path.join(root, 'src');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.ts');
    fs.writeFileSync(file, 'export {};');
    stamp(file, opts.srcAge ?? 60);
  }
  if (!opts.noDist) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    const file = path.join(root, 'dist', 'index.js');
    fs.writeFileSync(file, 'module.exports = {};');
    stamp(file, opts.distAge ?? 60);
  }
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('checkBuildFreshness', () => {
  it('reports staleness when src/ is newer than dist/', () => {
    const report = checkBuildFreshness(makeRoot({ srcAge: 10, distAge: 180 }));

    expect(report).not.toBeNull();
    expect(report!.behindBy).toBe('2h');
    expect(report!.newestSource).toBe(path.join('src', 'index.ts'));
  });

  it('stays silent when dist/ is newer than src/', () => {
    expect(checkBuildFreshness(makeRoot({ srcAge: 180, distAge: 10 }))).toBeNull();
  });

  it('tolerates a build that finished a beat after the last edit', () => {
    // tsc stamps output as it writes, so the last emitted file can land a
    // hair behind the edit that triggered the build.
    const root = makeRoot({});
    const now = Date.now();
    fs.utimesSync(path.join(root, 'src', 'index.ts'), new Date(now), new Date(now));
    fs.utimesSync(path.join(root, 'dist', 'index.js'), new Date(now - 500), new Date(now - 500));

    expect(checkBuildFreshness(root)).toBeNull();
  });

  it('finds the newest source in nested directories', () => {
    const report = checkBuildFreshness(makeRoot({ srcAge: 5, distAge: 300, nested: true }));

    expect(report!.newestSource).toBe(path.join('src', 'cli', 'deep', 'index.ts'));
  });

  it('is a no-op for an installed package, which ships dist/ with no src/', () => {
    expect(checkBuildFreshness(makeRoot({ noSrc: true }))).toBeNull();
  });

  it('is a no-op when dist/ has not been built yet', () => {
    expect(checkBuildFreshness(makeRoot({ noDist: true }))).toBeNull();
  });

  it('never throws on a nonexistent root', () => {
    expect(checkBuildFreshness('/definitely/not/a/real/path')).toBeNull();
  });
});

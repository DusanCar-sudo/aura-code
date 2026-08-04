#!/usr/bin/env node
/**
 * Restore the executable bit on every file listed in package.json "bin".
 *
 * Why this is needed: tsc writes its output with the default file mode (0644
 * under a normal umask) and does not preserve or set the executable bit. That
 * is invisible while dist/ persists across builds — the bit set by a previous
 * `npm link` or `npm install` survives an overwrite — but `npm run clean`
 * deletes dist/ outright, so the next build produces a fresh, non-executable
 * entry file. The bin symlink then points at a file the shell refuses to run:
 *
 *   bash: .../bin/aura: Permission denied     (exit 126)
 *
 * This started biting on every rebuild once prepublishOnly (clean && build)
 * landed, because that made clean-then-build the normal path rather than a
 * rare one.
 *
 * Run from "postbuild", so it fires after every `npm run build` — including
 * the build inside prepublishOnly — without anyone having to remember it.
 *
 * Reads the "bin" map instead of hardcoding paths: this package ships two
 * binaries (aura and dic) and both have the same problem, and a future rename
 * should not silently reintroduce it.
 *
 * Node rather than `chmod` so a fresh clone builds on Windows too, where
 * chmod does not exist and the executable bit is meaningless. Missing files
 * are reported but do not fail the build — whether the build succeeded is
 * tsc's call, and this hook should not invent new failure modes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

// "bin" is either a string (single binary named after the package) or a map.
const bin = pkg.bin ?? {};
const targets = typeof bin === 'string' ? [bin] : Object.values(bin);

if (targets.length === 0) {
  console.log('postbuild: no "bin" entries — nothing to make executable.');
  process.exit(0);
}

if (process.platform === 'win32') {
  console.log('postbuild: Windows — executable bit not applicable, skipping.');
  process.exit(0);
}

let fixed = 0;
let missing = 0;

for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.warn(`postbuild: WARNING — "bin" entry not found after build: ${rel}`);
    missing++;
    continue;
  }
  // 0o755 is the mode npm itself applies to package binaries on install.
  fs.chmodSync(file, 0o755);
  fixed++;
}

const summary = `postbuild: made ${fixed} binar${fixed === 1 ? 'y' : 'ies'} executable`;
console.log(missing > 0 ? `${summary} (${missing} missing)` : summary);

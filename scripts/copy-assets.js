#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets from src/ into dist/.
 *
 * tsc only emits files it compiles, so anything the running code opens at
 * runtime but never imports is simply absent from dist/ — and therefore from
 * the published tarball, since package.json "files" ships dist/. That failure
 * is invisible in development: a source checkout resolves the asset from src/
 * via __dirname and works perfectly, so it breaks only for installed users.
 *
 * Currently one asset: tools/screen/aura_screen.py, the computer-use sidecar.
 * It is spawned as a child process rather than imported, which is exactly the
 * shape tsc cannot see.
 *
 * Run from "postbuild" so it fires after every build, including the one inside
 * prepublishOnly, without anyone having to remember it.
 */
const fs = require('fs');
const path = require('path');

const ASSETS = ['tools/screen/aura_screen.py'];

const root = path.join(__dirname, '..');
let copied = 0;

for (const rel of ASSETS) {
  const from = path.join(root, 'src', rel);
  const to = path.join(root, 'dist', rel);
  if (!fs.existsSync(from)) {
    console.error(`copy-assets: MISSING ${path.join('src', rel)} — computer use will not work`);
    process.exitCode = 1;
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}

console.log(`copy-assets: copied ${copied}/${ASSETS.length} runtime asset(s) into dist/`);

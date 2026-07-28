#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Stage an installable Aura tree.
#
# Every platform installer (deb, rpm, Inno Setup, pkg, AppImage) packages the
# same thing: the published npm tree with production deps only, plus a launcher.
# Building that once here keeps the platforms from drifting — and means what we
# ship is byte-identical to what `npm i -g aura-code` produces, so there is no
# bundler to debug when something works in dev and not in the installer.
#
#   ./stage.sh [--out DIR] [--with-runtime]
#
#   --with-runtime   also download a private Node runtime into the tree, for
#                    platforms where we cannot depend on a system Node
#                    (Windows, macOS, AppImage). deb/rpm omit it and declare a
#                    dependency on nodejs instead.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/build/stage"
WITH_RUNTIME=0
NODE_VERSION="${NODE_VERSION:-22.12.0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out)          OUT="$2"; shift 2 ;;
    --with-runtime) WITH_RUNTIME=1; shift ;;
    -h|--help)      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
echo "==> Staging aura-code $VERSION -> $OUT"

rm -rf "$OUT"
mkdir -p "$OUT/app" "$OUT/bin"

# ── 1. Build, then pack ──────────────────────────────────────────────────────
# npm pack honours package.json "files", so the tarball is dist + README +
# LICENSE and none of the repo's working tree.
echo "==> Building"
( cd "$REPO_ROOT" && npm run build >/dev/null )

echo "==> Packing"
TARBALL="$( cd "$REPO_ROOT" && npm pack --silent --pack-destination "$OUT" )"
tar -xzf "$OUT/$TARBALL" -C "$OUT"
rm -f "$OUT/$TARBALL"
# npm pack roots everything under package/
mv "$OUT/package"/* "$OUT/app/"
rm -rf "$OUT/package"

# ── 2. Production dependencies only ──────────────────────────────────────────
# Dev deps (typescript, vite, rollup, esbuild) roughly double the tree and are
# useless at runtime.
echo "==> Installing production dependencies"
( cd "$OUT/app" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent )

# ── 2b. Prune what an installed CLI never reads ──────────────────────────────
# Measured on 0.12.2: 130M -> ~85M. Nothing here is reachable at runtime.
echo "==> Pruning"
BEFORE_KB="$(du -sk "$OUT/app" | cut -f1)"

# gpt-tokenizer ships four copies of itself (dist/ esm/ cjs/ src/) plus data.
# Resolution goes through esm/ (package main) and cjs/; dist/ and src/ are
# dead weight — 25M of it. Verified: require('gpt-tokenizer').encode and the
# compactor's countText both still work after this.
rm -rf "$OUT/app/node_modules/gpt-tokenizer/dist" \
       "$OUT/app/node_modules/gpt-tokenizer/src" 2>/dev/null || true

# Source maps are ~20M and only matter when debugging the dependency itself.
find "$OUT/app/node_modules" -name '*.js.map' -delete 2>/dev/null || true
find "$OUT/app/node_modules" -name '*.ts.map' -delete 2>/dev/null || true

# Per-dependency docs and test suites.
find "$OUT/app/node_modules" -type d \
     \( -name test -o -name tests -o -name __tests__ -o -name example -o -name examples \) \
     -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT/app/node_modules" -maxdepth 3 -type f \
     \( -iname 'CHANGELOG*' -o -iname 'CONTRIBUTING*' -o -iname '*.markdown' \) \
     -delete 2>/dev/null || true

AFTER_KB="$(du -sk "$OUT/app" | cut -f1)"
echo "    $((BEFORE_KB/1024))M -> $((AFTER_KB/1024))M"

# The tokenizer is optional (compactor falls back to a char-ratio estimate),
# but a silent downgrade to estimates would be a real regression, so fail the
# build rather than ship it broken.
if ! ( cd "$OUT/app" && node -e "
  const t = require('gpt-tokenizer');
  if (typeof t.encode !== 'function' || t.encode('hello world').length < 1) process.exit(1);
" 2>/dev/null ); then
  echo "gpt-tokenizer broken after pruning — aborting" >&2
  exit 1
fi

# ── 3. Optional private Node runtime ─────────────────────────────────────────
if [ "$WITH_RUNTIME" -eq 1 ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   NODE_DIST="node-v$NODE_VERSION-linux-x64" ;;
    Linux-aarch64)  NODE_DIST="node-v$NODE_VERSION-linux-arm64" ;;
    Darwin-x86_64)  NODE_DIST="node-v$NODE_VERSION-darwin-x64" ;;
    Darwin-arm64)   NODE_DIST="node-v$NODE_VERSION-darwin-arm64" ;;
    *) echo "no Node runtime mapping for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac

  echo "==> Fetching Node $NODE_VERSION ($NODE_DIST)"
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.xz" -o "$TMP/node.tar.xz"

  # Verify against the release's signed checksum list rather than trusting the
  # download — this runtime ends up inside a signed installer.
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  EXPECTED="$(grep " $NODE_DIST.tar.xz\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(sha256sum "$TMP/node.tar.xz" | awk '{print $1}')"
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "checksum mismatch for $NODE_DIST.tar.xz" >&2
    echo "  expected: ${EXPECTED:-<not found in SHASUMS256.txt>}" >&2
    echo "  actual:   $ACTUAL" >&2
    rm -rf "$TMP"; exit 1
  fi

  mkdir -p "$OUT/runtime"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP"
  cp -a "$TMP/$NODE_DIST"/. "$OUT/runtime/"
  rm -rf "$TMP"
  # Trim what a CLI never needs.
  rm -rf "$OUT/runtime/include" "$OUT/runtime/share" "$OUT/runtime/lib/node_modules/npm/docs"
fi

# ── 4. Launchers ─────────────────────────────────────────────────────────────
# Bundled-runtime builds resolve node next to the app; system-runtime builds
# (deb/rpm) rely on nodejs being on PATH, which the package declares.
if [ "$WITH_RUNTIME" -eq 1 ]; then
  cat > "$OUT/bin/aura" <<'LAUNCHER'
#!/bin/sh
# Resolve through symlinks so the launcher works from /usr/local/bin.
SELF="$0"
while [ -h "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *)  SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
HERE="$(cd "$(dirname "$SELF")/.." && pwd)"
exec "$HERE/runtime/bin/node" "$HERE/app/dist/cli/index.js" "$@"
LAUNCHER
else
  cat > "$OUT/bin/aura" <<'LAUNCHER'
#!/bin/sh
exec /usr/bin/node /usr/lib/aura-code/dist/cli/index.js "$@"
LAUNCHER
fi
chmod 755 "$OUT/bin/aura"

echo "==> Staged $(du -sh "$OUT" | cut -f1) at $OUT"
echo "    version: $VERSION"
echo "    runtime: $([ "$WITH_RUNTIME" -eq 1 ] && echo bundled || echo system)"

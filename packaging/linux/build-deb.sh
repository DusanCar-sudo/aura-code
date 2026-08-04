#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build aura-code_<version>_all.deb
#
# Uses dpkg-deb directly rather than nfpm or debhelper: the payload is a
# pre-staged tree plus five metadata files, so a build tool would add a
# dependency without removing any work. Needs only dpkg-deb and fakeroot,
# both of which any Debian/Ubuntu box already has.
#
# Depends on system nodejs (>= 18) instead of bundling a runtime — that is
# what a distro package is supposed to do, and apt/GNOME Software resolve it
# automatically, so double-click install still works.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$REPO_ROOT/build/stage"
OUT_DIR="$REPO_ROOT/build/dist"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
PKG="aura-code"
ARCH="all"
ROOT="$REPO_ROOT/build/deb/$PKG-$VERSION"

if [ ! -d "$STAGE/app" ]; then
  echo "no staged tree — run packaging/common/stage.sh first" >&2
  exit 1
fi

echo "==> Building $PKG $VERSION ($ARCH)"
rm -rf "$ROOT"
mkdir -p "$ROOT/DEBIAN" \
         "$ROOT/usr/lib/$PKG" \
         "$ROOT/usr/bin" \
         "$ROOT/usr/share/applications" \
         "$ROOT/usr/share/bash-completion/completions" \
         "$ROOT/usr/share/doc/$PKG" \
         "$ROOT/usr/lib/systemd/user"

# ── Payload ──────────────────────────────────────────────────────────────────
cp -a "$STAGE/app/dist"         "$ROOT/usr/lib/$PKG/"
cp -a "$STAGE/app/node_modules" "$ROOT/usr/lib/$PKG/"
cp -a "$STAGE/app/package.json" "$ROOT/usr/lib/$PKG/"
install -m 755 "$STAGE/bin/aura" "$ROOT/usr/bin/aura"

install -m 644 "$REPO_ROOT/packaging/fedora/aura-code.desktop" \
               "$ROOT/usr/share/applications/aura-code.desktop"
install -m 644 "$REPO_ROOT/packaging/fedora/aura-code.bash-completion" \
               "$ROOT/usr/share/bash-completion/completions/aura"
install -m 644 "$REPO_ROOT/packaging/fedora/aura-code-server.service" \
               "$ROOT/usr/lib/systemd/user/aura-code-server.service"
install -m 644 "$REPO_ROOT/LICENSE" "$ROOT/usr/share/doc/$PKG/copyright"
install -m 644 "$REPO_ROOT/README.md" "$ROOT/usr/share/doc/$PKG/README.md"

INSTALLED_KB="$(du -sk "$ROOT" | cut -f1)"

# ── Metadata ─────────────────────────────────────────────────────────────────
cat > "$ROOT/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: devel
Priority: optional
Architecture: $ARCH
Depends: nodejs (>= 18)
Installed-Size: $INSTALLED_KB
Maintainer: Dusan Milosavljevic <leanprogressiq@gmail.com>
Homepage: https://github.com/DusanCar-sudo/aura-code
Description: Model-agnostic AI coding agent
 Aura is an autonomous AI coding agent that works with Claude, GPT, Gemini,
 Grok, local models via Ollama, or any OpenAI-compatible endpoint. It reads
 your codebase, plans, executes, verifies, and reports back.
 .
 Installs the "aura" command. Run "aura setup --web" once to choose a
 provider and enter an API key.
EOF

# Config lives in the user's home, so there are no conffiles to declare.

cat > "$ROOT/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e

if [ "$1" = "configure" ]; then
    cat <<'BANNER'

  Aura installed.

  Finish setup (choose a provider and enter an API key):

      aura setup --web

  Then run `aura` in any project directory.

BANNER
fi

exit 0
EOF
chmod 755 "$ROOT/DEBIAN/postinst"

cat > "$ROOT/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e

# Stop the optional user service if someone enabled it; leaving it running
# would keep a dead path alive after the files are gone.
if [ "$1" = "remove" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop aura-code-server.service >/dev/null 2>&1 || true
fi

exit 0
EOF
chmod 755 "$ROOT/DEBIAN/prerm"

# ── Assemble ─────────────────────────────────────────────────────────────────
# fakeroot so payload files end up root-owned without building as root.
mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/${PKG}_${VERSION}_${ARCH}.deb"
fakeroot dpkg-deb --build --root-owner-group "$ROOT" "$DEB" >/dev/null

echo "==> $DEB"
ls -lh "$DEB" | awk '{print "    size: " $5}'

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the Windows installer (AuraCode-<version>-setup.exe).
#
# Windows support is WSL-based, so the .exe is a thin wrapper: it carries the
# Linux .deb and installs it inside the user's WSL distro. That means this
# build depends on the .deb already existing.
#
# Needs the Inno Setup compiler (iscc). On Linux that means wine:
#     winetricks -q innosetup     (or run this on Windows / a Windows runner)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/packaging/windows"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
DEB="$REPO_ROOT/build/dist/aura-code_${VERSION}_all.deb"

if [ ! -f "$DEB" ]; then
  echo "missing $DEB" >&2
  echo "run: make -C packaging deb" >&2
  exit 1
fi

# iscc directly (Windows / PATH), else through wine.
if command -v iscc >/dev/null 2>&1; then
  ISCC=(iscc)
elif command -v wine >/dev/null 2>&1 \
  && [ -f "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe" ]; then
  ISCC=(wine "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe")
else
  cat >&2 <<'EOF'
Inno Setup compiler (iscc) not found.

  On Windows:  install Inno Setup 6 and ensure ISCC.exe is on PATH
  On Linux:    winetricks -q innosetup
  In CI:       use a windows-latest runner (Inno Setup is preinstalled)

The .deb in build/dist is unaffected — only the .exe wrapper needs this.
EOF
  exit 1
fi

echo "==> Building Windows installer $VERSION"
"${ISCC[@]}" "/DAppVersion=$VERSION" "$HERE/aura.iss"

EXE="$REPO_ROOT/build/dist/AuraCode-${VERSION}-setup.exe"
if [ -f "$EXE" ]; then
  echo "==> $EXE"
  ls -lh "$EXE" | awk '{print "    size: " $5}'
else
  echo "iscc reported success but $EXE is missing" >&2
  exit 1
fi

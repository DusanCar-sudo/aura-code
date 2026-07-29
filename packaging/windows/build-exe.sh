#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the Windows installer (AuraCode-<version>-setup.exe).
#
# Windows is now a native install: a private Node runtime plus the app, with a
# launcher on PATH. The payload is staged by stage-windows.ps1, which has to
# run on Windows — its npm install must resolve win32 dependencies, and it
# smoke-tests the staged tree before packaging.
#
# So this script is really only useful on Windows or a Windows runner. On
# Linux it will say so rather than producing something untested.
# The authoritative build is .github/workflows/release-windows.yml.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/packaging/windows"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
STAGE="$REPO_ROOT/build/stage-win"

if [ ! -d "$STAGE" ]; then
  cat >&2 <<EOF
No staged payload at $STAGE

The Windows payload must be staged on Windows (PowerShell):

    ./packaging/windows/stage-windows.ps1

That downloads the Node runtime, verifies it against nodejs.org's SHASUMS,
installs production dependencies, and smoke-tests the result. Cross-staging
from Linux would skip win32 dependency resolution and ship something untested.

In CI this happens automatically:
    .github/workflows/release-windows.yml   (windows-latest)
EOF
  exit 1
fi

# iscc directly (Windows / PATH), else through wine.
if command -v iscc >/dev/null 2>&1; then
  ISCC=(iscc)
elif command -v ISCC.exe >/dev/null 2>&1; then
  ISCC=(ISCC.exe)
elif command -v wine >/dev/null 2>&1 \
  && [ -f "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe" ]; then
  ISCC=(wine "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe")
else
  cat >&2 <<'EOF'
Inno Setup compiler (iscc) not found.

  On Windows:  choco install innosetup   (then ISCC.exe is on PATH)
  On Linux:    winetricks -q innosetup
  In CI:       .github/workflows/release-windows.yml handles this

The .deb and .rpm are unaffected — only the .exe needs this.
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

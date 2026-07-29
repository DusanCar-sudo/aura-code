#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install Aura inside a WSL distribution.
#
# No longer called by the Windows installer — that installs natively now the
# shell guardrails cover cmd.exe and PowerShell. Kept because WSL is still the
# better-trodden route on Windows, and the startup notice points there when
# something behaves oddly. Run it by hand against the .deb:
#
#     bash install-into-wsl.sh /mnt/c/Users/you/Downloads/aura-code_0.12.2_all.deb
#
# The .deb depends on nodejs (>= 18). Distro repos often carry something older
# (Ubuntu 22.04 ships Node 12), so this checks the *actual* version rather than
# trusting the package manager to satisfy the dependency, and installs NodeSource
# when it falls short.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEB="${1:-}"
MIN_NODE_MAJOR=18

die() { printf '\n  Error: %s\n\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

printf '\n  Installing Aura into WSL\n\n'

[ -n "$DEB" ] || die "no .deb path given (usage: $0 <path-to-.deb>)"
[ -f "$DEB" ] || die "cannot read $DEB"

# ── Sanity: are we actually in WSL? ──────────────────────────────────────────
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  say "Warning: this does not look like WSL. Continuing anyway."
fi

# ── sudo ─────────────────────────────────────────────────────────────────────
# WSL's default user is non-root with passwordless sudo in most distros, but
# not all — if a password is needed, the prompt must be visible, so no -n here.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  die "sudo is not available and this is not running as root"
fi

# ── Package manager ──────────────────────────────────────────────────────────
if ! command -v apt-get >/dev/null 2>&1; then
  die "this installer supports Debian/Ubuntu WSL distros (apt-get not found).
  For other distros, install the .rpm or use: npm install -g aura-code"
fi

# ── Node ─────────────────────────────────────────────────────────────────────
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

CURRENT="$(node_major)"
if [ "$CURRENT" -ge "$MIN_NODE_MAJOR" ]; then
  say "Node $(node -v) — ok"
else
  if [ "$CURRENT" -eq 0 ]; then
    say "Node not found — installing Node 22 from NodeSource"
  else
    say "Node $(node -v) is too old (need >= $MIN_NODE_MAJOR) — installing Node 22"
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null 2>&1 \
    || die "could not add the NodeSource repository (no network?)"
  $SUDO apt-get install -y nodejs >/dev/null 2>&1 \
    || die "could not install nodejs"
  say "Node $(node -v) installed"
fi

# ── Aura ─────────────────────────────────────────────────────────────────────
say "Installing the Aura package"
$SUDO apt-get update -qq >/dev/null 2>&1 || true
# apt-get install on a local .deb resolves dependencies; dpkg -i would not.
$SUDO apt-get install -y "$DEB" >/dev/null 2>&1 \
  || $SUDO apt-get install -y -f >/dev/null 2>&1 \
  || die "package installation failed — try: sudo apt-get install -y '$DEB'"

command -v aura >/dev/null 2>&1 || die "installed, but 'aura' is not on PATH"

cat <<'DONE'

  Aura is installed.

  Next: choose a provider and enter an API key.

      aura setup --web

  Then run `aura` in any project directory.

DONE

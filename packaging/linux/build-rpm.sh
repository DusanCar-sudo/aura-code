#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build aura-code-<version>.noarch.rpm from the staged tree.
#
# This is the *binary* path — it packages what packaging/common/stage.sh
# already produced, so the .rpm and .deb ship identical bytes. It is not a
# replacement for packaging/fedora/aura-code.spec, which builds from source
# and is what Copr/Packit use for Fedora proper.
#
# Needs rpmbuild (dnf install rpm-build / apt install rpm).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$REPO_ROOT/build/stage"
OUT_DIR="$REPO_ROOT/build/dist"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
PKG="aura-code"
TOP="$REPO_ROOT/build/rpm"

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "rpmbuild not found — install rpm-build (Fedora) or rpm (Debian/Ubuntu)" >&2
  exit 1
fi
if [ ! -d "$STAGE/app" ]; then
  echo "no staged tree — run packaging/common/stage.sh first" >&2
  exit 1
fi

echo "==> Building $PKG $VERSION (noarch rpm)"
rm -rf "$TOP"
mkdir -p "$TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Lay the payload out as it will be installed, then tar it as the source.
PAYLOAD="$TOP/payload/$PKG-$VERSION"
mkdir -p "$PAYLOAD"
cp -a "$STAGE/app/dist" "$STAGE/app/node_modules" "$STAGE/app/package.json" "$PAYLOAD/"
cp -a "$STAGE/bin/aura" "$PAYLOAD/aura.launcher"
cp -a "$REPO_ROOT/LICENSE" "$REPO_ROOT/README.md" "$PAYLOAD/"
cp -a "$REPO_ROOT/packaging/fedora/aura-code.desktop" \
      "$REPO_ROOT/packaging/fedora/aura-code.bash-completion" \
      "$REPO_ROOT/packaging/fedora/aura-code-server.service" "$PAYLOAD/"

tar -czf "$TOP/SOURCES/$PKG-$VERSION.tar.gz" -C "$TOP/payload" "$PKG-$VERSION"

cat > "$TOP/SPECS/$PKG-bin.spec" <<EOF
Name:           $PKG
Version:        $VERSION
Release:        1%{?dist}
Summary:        Model-agnostic AI coding agent

License:        MIT
URL:            https://github.com/DusanCar-sudo/aura-code
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch
Requires:       nodejs >= 18

# The payload is prebuilt JavaScript; there is nothing to strip, and the
# bundled deps are not system libraries.
%global __requires_exclude_from ^%{_libdir}/%{name}/.*\$
%global debug_package %{nil}

%description
Aura is an autonomous AI coding agent that works with Claude, GPT, Gemini,
Grok, local models via Ollama, or any OpenAI-compatible endpoint. It reads
your codebase, plans, executes, verifies, and reports back.

Installs the "aura" command. Run "aura setup --web" once to choose a
provider and enter an API key.

%prep
%setup -q

%install
mkdir -p %{buildroot}%{_prefix}/lib/%{name}
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/bash-completion/completions
mkdir -p %{buildroot}%{_userunitdir}

cp -a dist node_modules package.json %{buildroot}%{_prefix}/lib/%{name}/
install -m 755 aura.launcher %{buildroot}%{_bindir}/aura
install -m 644 aura-code.desktop %{buildroot}%{_datadir}/applications/aura-code.desktop
install -m 644 aura-code.bash-completion %{buildroot}%{_datadir}/bash-completion/completions/aura
install -m 644 aura-code-server.service %{buildroot}%{_userunitdir}/aura-code-server.service

%post
cat <<'BANNER'

  Aura installed.

  Finish setup (choose a provider and enter an API key):

      aura setup --web

  Then run \`aura\` in any project directory.

BANNER

%preun
if [ \$1 -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop aura-code-server.service >/dev/null 2>&1 || true
fi

%files
%license LICENSE
%doc README.md
%{_bindir}/aura
%{_prefix}/lib/%{name}/
%{_datadir}/applications/aura-code.desktop
%{_datadir}/bash-completion/completions/aura
%{_userunitdir}/aura-code-server.service

%changelog
* Tue Jul 28 2026 Dusan Milosavljevic <leanprogressiq@gmail.com> - $VERSION-1
- Binary package built from the shared staged tree
EOF

rpmbuild --define "_topdir $TOP" -bb "$TOP/SPECS/$PKG-bin.spec" >"$TOP/build.log" 2>&1 || {
  echo "rpmbuild failed — tail of $TOP/build.log:" >&2
  tail -25 "$TOP/build.log" >&2
  exit 1
}

mkdir -p "$OUT_DIR"
RPM="$(find "$TOP/RPMS" -name '*.rpm' | head -1)"
cp "$RPM" "$OUT_DIR/"
echo "==> $OUT_DIR/$(basename "$RPM")"
ls -lh "$OUT_DIR/$(basename "$RPM")" | awk '{print "    size: " $5}'

Name:           aura-code
Version:        0.12.2
Release:        1%{?dist}
Summary:        Model-agnostic AI coding agent

License:        MIT
URL:            https://github.com/DusanCar-sudo/aura-code
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch

BuildRequires:  nodejs >= 18
BuildRequires:  npm

Requires:       nodejs >= 18

%description
Aura is a model-agnostic AI coding agent that works with Claude,
GPT-4o, Gemini, Grok, local Llama via Ollama, or any OpenAI-compatible
endpoint. It provides a CLI, interactive REPL, and web-based interface
for AI-assisted software engineering tasks.

The package installs the `aura` command.

Features:
- Multi-provider: Anthropic, OpenAI, Google Gemini, xAI Grok, Xiaomi MiMo,
  OpenRouter, Ollama, LM Studio, plus custom OpenAI-compatible endpoints
- Streaming responses with real-time token display
- Persistent memory across sessions
- Gazelle mode: a lean conversational path for non-coding turns
- Three permission modes: normal, read-only, auto
- Resilience: retry with backoff, circuit breaker, rate limiting,
  provider fallback chains
- Interactive TUI with model switching, session stats
- Web server with WebSocket-based real-time chat UI and remote tool approval
- Project auto-detection for Node.js, Python, Rust, Go

%prep
%setup -q

%build
npm ci --production=false
npm run build

%install
mkdir -p %{buildroot}%{_libdir}/%{name}
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/bash-completion/completions
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_userunitdir}

# Ship only production deps — the build ones (typescript, vite, rollup)
# roughly double the installed size and are useless at runtime.
npm prune --omit=dev

cp -a dist %{buildroot}%{_libdir}/%{name}/dist
cp -a node_modules %{buildroot}%{_libdir}/%{name}/node_modules
cp -a package.json %{buildroot}%{_libdir}/%{name}/package.json

# The command is `aura` (package.json bin), not the package name.
cat > %{buildroot}%{_bindir}/aura << 'EOF'
#!/bin/bash
exec %{_bindir}/node %{_libdir}/aura-code/dist/cli/index.js "$@"
EOF
chmod 755 %{buildroot}%{_bindir}/aura

cp packaging/fedora/aura-code.bash-completion %{buildroot}%{_datadir}/bash-completion/completions/aura
cp packaging/fedora/aura-code.desktop %{buildroot}%{_datadir}/applications/aura-code.desktop
cp packaging/fedora/aura-code-server.service %{buildroot}%{_userunitdir}/aura-code-server.service

%check
npm test

%files
%license LICENSE
%doc README.md
%{_bindir}/aura
%{_libdir}/%{name}/
%{_datadir}/bash-completion/completions/aura
%{_datadir}/applications/aura-code.desktop
%{_userunitdir}/aura-code-server.service

%changelog
* Tue Jul 28 2026 Dusan Milosavljevic <leanprogressiq@gmail.com> - 0.12.2-1
- Rename package from ruby-code to aura-code; install the `aura` command
- Sync version with package.json

* Wed Jun 04 2026 Dusan Milosavljevic <dusan@example.com> - 0.1.0-1
- Initial Fedora packaging

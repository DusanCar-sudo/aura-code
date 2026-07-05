Name:           ruby-code
Version:        0.1.0
Release:        1%{?dist}
Summary:        Model-agnostic AI coding agent

License:        MIT
URL:            https://github.com/YOUR_USERNAME/ruby-code
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch

BuildRequires:  nodejs >= 18
BuildRequires:  npm

Requires:       nodejs >= 18

%description
ruby-code is a model-agnostic AI coding agent that works with Claude,
GPT-4o, Gemini, Grok, local Llama via Ollama, or any OpenAI-compatible
endpoint. It provides a CLI, interactive REPL, and web-based interface
for AI-assisted software engineering tasks.

Features:
- Multi-provider: Anthropic, OpenAI, Google Gemini, xAI Grok, Xiaomi MiMo,
  OpenRouter, Ollama, LM Studio, plus custom OpenAI-compatible endpoints
- Streaming responses with real-time token display
- 10 tools: read, edit, write files, search code, run shell commands,
  run tests, git operations, sub-agent spawning
- Three permission modes: normal, read-only, auto
- Resilience: retry with backoff, circuit breaker, rate limiting,
  provider fallback chains
- Interactive REPL with model switching, session stats
- Web server with WebSocket-based real-time chat UI
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

cp -a dist %{buildroot}%{_libdir}/%{name}/dist
cp -a node_modules %{buildroot}%{_libdir}/%{name}/node_modules
cp -a package.json %{buildroot}%{_libdir}/%{name}/package.json

cat > %{buildroot}%{_bindir}/ruby-code << 'EOF'
#!/bin/bash
exec %{_bindir}/node %{_libdir}/%{name}/dist/cli/index.js "$@"
EOF
chmod 755 %{buildroot}%{_bindir}/ruby-code

cp packaging/fedora/ruby-code.bash-completion %{buildroot}%{_datadir}/bash-completion/completions/ruby-code
cp packaging/fedora/ruby-code.desktop %{buildroot}%{_datadir}/applications/ruby-code.desktop
cp packaging/fedora/ruby-code-server.service %{buildroot}%{_userunitdir}/ruby-code-server.service

%check
npm test

%files
%license LICENSE
%doc README.md
%{_bindir}/ruby-code
%{_libdir}/%{name}/
%{_datadir}/bash-completion/completions/ruby-code
%{_datadir}/applications/ruby-code.desktop
%{_userunitdir}/ruby-code-server.service

%changelog
* Wed Jun 04 2026 Dusan Milosavljevic <dusan@example.com> - 0.1.0-1
- Initial Fedora packaging

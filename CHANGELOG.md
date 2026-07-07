# Changelog

All notable changes to Aura Code are documented here.

## [0.8.0] — 2026-07-07

### Added
- **Context health dashboard** — `/context` shows a token-usage bar, the
  compaction generation/ladder state, and running cost for the session.
- **`aura doctor`** — self-diagnostic for Aura's own install: `--doctor` flag
  and `:doctor` REPL command, 10 check categories (build, config, deps, env,
  git, and more), 4 kinds of auto-repair via `--doctor --fix`.

### Fixed
- **Silent process death after any reply.** `processLine()`'s try/catch in
  `src/cli/index.ts` only wrapped the agent-loop call itself; everything
  after it — session persistence, episode recording, stats display, TTS,
  the `:btw` follow-up block — ran unguarded. Since the REPL never awaits
  or `.catch()`s that promise, any exception in the tail became an
  unhandled rejection, which kills the process on Node 22 by default. The
  whole post-task tail is now inside the try/catch, plus a global
  `unhandledRejection` handler prints a visible error instead of dying
  silently for anything this class of bug produces in the future.
- **`resolveTaskModelBaseUrl` and 4 related provider-factory helpers had
  been silently dropped** by an earlier "restore from backup" commit,
  breaking base-URL/model pairing safety for Telegram-bot and CLI provider
  resolution. Reinstated and extended for providers added since (Zhipu/GLM,
  OpenCode Go).
- **`runDream` didn't match its own test suite's spec** — rebuilt with a
  persisted cutoff (`dreams/.state.json`) that only advances after a
  successful write, so episodes are never burned on a provider failure or
  empty response, plus a one-time local-Ollama fallback retry.
- **`RubyAlternator` defaulted to `PermissionSystem('auto')`**, meaning its
  small-model attempt path could auto-approve destructive tool calls
  regardless of the session's actual permission mode. Now defaults to
  `'normal'` and accepts an injected `PermissionSystem`; also now threads
  `confirmFn`/`initialHistory` through to the agent loop and returns the
  full `LoopResult` instead of a flattened summary string.
- **Codebase-graph extractor left a dangling edge** whenever a repo has a
  `CHANGELOG.md` — the `aligns_with` edge pointed at a `constraint:changes`
  node that was never created.
- **`:machina`'s AAM self-check claims had drifted** from the restructured
  agent loop and compactor (generational compaction ladder replaced the old
  fixed threshold) — line anchors re-verified against live source.

### Tests
- Full suite: **1317 passing, 0 failures** (94 files), up from 35 failing /
  1282 passing at the start of this cleanup pass. Root-caused and fixed
  independently: provider-factory functions, the wizard integration tests
  (rewritten against a local stub endpoint instead of the pre-recovery
  wizard's menu), `:dream`, `:machina`, `RubyAlternator`, and the
  perception-extractor dangling-edge check.

## [0.6.1] — 2026-06-25

### Added
- **`:rem` graph** — parses `dreams/*.md` into a night/tag relations graph instead of just dumping the latest dream file; terminal view (timeline, top recurring tags, recent detail) plus `:rem --html` for a standalone SVG graph + ranked table at `dreams/rem.html`
- **`:machina`** — formal model of Aura as an Abstract Agent Machine, the 5-tuple (S, P, O, δ, s₀); every structural claim (main loop, oracle call, safety gate, compaction threshold, maxTurns, primitives) is checked against the live source tree at run time rather than asserted once and left to drift. `:machina --html` writes the full writeup + diagram to `docs/machina.html`
- `⚠` high-token-usage marker for `:machina` in `:help`, plus a runtime warning printed before it executes

### Fixed
- **402 cost-gate errors** — default `maxTokens` lowered from 4096 to 2048 (aligned across all providers); cost-gated endpoints (OpenRouter `:free` routes, low-balance keys) reject on worst-case cost (`prompt_tokens + max_tokens`), so a high ceiling could trigger 402 even with credit remaining

### Tests
- `:dream` consolidation: 8 new tests covering the empty-day skip, cutoff advancement, `since`/`full` filtering, and the no-burn-on-failure invariant (including the Ollama fallback path)
- `:rem`: 20 new tests covering dream-file parsing, graph construction, and both renderers
- `:machina`: 15 new tests, including one that runs against the real checked-out source and fails if any AAM claim has drifted

## [0.6.0] — 2026-06-25

### Added
- **Gmail OAuth setup flow** — `setup`/`setup_finish`/`setup_status` commands; tokens never echoed in chat
- **`:research` command** — multi-step research saved to `research/*.md`
- **`:council` (Ecclesia)** — 5-agent panel research with synthesized verdict
- **Gmail API tool** — read, send, and list emails directly from Aura
- **Telegram wizard** — interactive Telegram bot setup through CLI
- **Telegram per-chat history** — conversation history no longer starts fresh every message; `/clear` actually clears it
- **Telegram voice** — IPv6 fix with curl fallback; local file upload support
- **Learnlight engine** — lesson-prep, report, and driven modules
- **Video render** — animation rendering pipeline
- **Viz** — stable 3D-spread orbit (no flicker) + working scroll-zoom
- Gmail send now detects HTML content and sets correct Content-Type; adds `From` header from authenticated user

### Documentation
- `docs/GMAIL-SETUP.md` — Gmail OAuth setup guide
- `docs/TELEGRAM-SETUP.md` — Telegram bot setup guide (recovered)
- `docs/HER_RUBYNESS.md` — Her Rubyness documentation
- `docs/KANBAN-MANUAL.md` — Kanban board manual

### Fixed
- `marked` dependency added to `package.json` (was only in lockfile, broke `npm ci` in CI)
- RubyModel tests now deterministic (mock delegate, not global fetch)
- Web-build detector false positives narrowed
- `:dream` no longer burns episodes on provider failure
- Provider test strips routing prefixes from model IDs
- Puppeteer `page.evaluate` now has DOM lib reference
- Gmail send includes proper `From` header and HTML content type detection

## Unreleased

### Added
- DeepSeek V4 Pro and V4 Flash model shortcuts via OpenRouter (`openrouter/deepseek/deepseek-v4-pro`, `openrouter/deepseek/deepseek-v4-flash:free`)
- **Conversation compaction** (`src/agent/compactor.ts`) — long sessions now automatically summarize older turns once usage crosses ~70% of the model's real context window, keeping the original task and recent turns verbatim. Uses each provider's actual context-window size rather than a guess. Known limitation: a rare edge case involving back-to-back assistant-role messages at the compaction boundary is still being hardened.
- **Radial layout for the Codebase Graph.** Toggle between the existing force-directed view and a new radial view that arranges nodes in concentric rings by type (files innermost, outward from there).
- **3D Learning charts.** The dashboard's Learning tab now renders category and model breakdowns as true rotatable 3D bar charts (drag to rotate, auto-rotates when idle, hover for details) alongside the existing 2D trend charts.

### Fixed
- **Codebase Graph extraction was never wired to persistence.** The `:graph refresh` command was a non-functional stub that printed a status line and did nothing else; the underlying extraction worked but its output was never saved anywhere the dashboard could read. Both are now connected — `:graph refresh` performs real extraction and reports actual node/edge counts, and extraction during normal task routing now persists automatically.
- **Memory Growth dashboard panel was reading from a path nothing ever wrote to**, so it always appeared empty. Fixed to read the real memory store, and added a genuine growth-over-time chart.
- **Dashboard charts were sizing against hidden, zero-width panels** at page load, since only the first tab is visible initially. All chart panels now defer rendering until their tab is actually shown.
- **Provider error messages were uninformative on failure** — a 400 error from a provider would show as "(no body)" with no useful detail, since the real error body the SDK received was never read. Errors now surface the actual provider response.
- **CLI output box truncated long lines instead of wrapping them**, cutting off markdown tables and long bullet points mid-sentence. Long lines now wrap across multiple box lines; the box itself is also wider on modern terminals (was capped at 72 columns regardless of actual terminal width).
- **Graph node colors/sizes didn't cover the extractor's real node types** (`concept`, `decision`, `constraint` all rendered as the same generic gray dot with no visual distinction).

### Security
- Removed a generated dashboard HTML file from git tracking that could embed the full contents of the local memory store (personal notes, credentials references, etc.) into a committed file. Verified this had not actually leaked any personal data in prior commits before removing it going forward. `graphify-out/` and `.aura/` are now gitignored.

## [0.3.7] — 2026-06-20

### Fixed
- The published CLI binary (`dist/cli/index.js`) was losing its executable permission on every build, causing `aura: Permission denied` for anyone installing or updating the package. The build script now sets the executable bit as part of `npm run build`.

## [0.3.6] — 2026-06-20

### Fixed
- **Regression in 0.3.4/0.3.5** — a syntax error introduced during a manual edit was compiled into invalid JavaScript and published to npm. Affected installs crashed immediately with `SyntaxError: Unexpected token` on startup. This release contains the corrected source; 0.3.4 and 0.3.5 are deprecated on the registry.
- `RateLimiter.acquire()` could spuriously report a 1ms wait on an instant token acquisition under system load, causing an intermittent test failure. The instant-success path no longer reads the clock at all.
- `resolveProviderTransport()` only prevented a saved provider's `baseUrl` from leaking onto an unrelated model when there was existing saved/global config to compare against. On a clean environment (fresh install, CI, or after `--reset-setup`) the guard never activated, so a MiMo or DeepSeek endpoint could silently be used for the wrong provider's model. The check now also recognises known default endpoints directly, independent of any saved configuration.

## [0.3.3] — 2026-06-20

### Removed
- Removed an unrelated apartment-surveillance/webcam-snapshot tool that had been added to the tool registry and shipped in the published package. Out of scope for a coding agent — anyone who wants that capability can have Aura generate it on demand instead of it being bundled by default.

## [0.3.2] — 2026-06-19

### Added
- Interactive provider setup wizard (`:provider` in the REPL, or on first run): select provider → model → API key → test connection → save.
- Xiaomi MiMo provider connection testing.
- `.env` file loader for API keys and configuration.

### Changed
- Telegram bot: safety-mode confirmation flow and task-cancellation improvements.

## [0.3.1] — 2026-06-19

### Fixed
- `maxTokens` was not forwarded from config through the provider factory to individual provider constructors, so providers fell back to a hardcoded 8096 regardless of configuration. The factory now passes it through, and the default was lowered from 32000 to 16000.

## [0.3.0] — 2026-06-15

### Rebrand
- **Renamed** from Rubyness / ruby-code to **Aura Code** (`aura-code` on npm)
- Binary: `aura` (was `ruby` / `rubyness`)
- Config directory: `~/.aura/` (was `~/.rubycode/`)
- Env var prefix: `AURA_` (was `RUBY_`)
- GitHub repo: `milodule3-debug/aura-code` (redirected from `rubyness`)

### Added
- Xiaomi MiMo provider (`mimo-v2.5-pro`, `mimo-v2.5`)
- OpenRouter support via `openrouter/<model>` syntax
- MCP (Model Context Protocol) client — connect to external tool servers
- YouTube transcript extraction tool (`youtube-transcript.ts`)
- Audio transcription tool (`audio-transcribe.ts`) via Groq Whisper API
- Architect mode for high-level design before implementation
- Verify mode with automatic retry on failure
- Analyze mode for session history failure pattern detection
- Session persistence with `--resume` and `--list-sessions`
- GitHub Actions CI pipeline — Node 24, 56 test files, 880 tests
- CodeQL security analysis — 0 alerts (17+2 CodeQL fixes applied)
- `--profile local` for offline Ollama usage
- `--plan` flag to preview execution plan before running

### Changed
- All ASCII art, banners, and help text updated to Aura branding
- README rewritten for clarity and discoverability
- Test suite expanded from 734 to **880 tests** across 56 test files

### Fixed
- 17 CodeQL security alerts resolved across 4 groups
- 2 CodeQL alerts: regex script-tag counting in dashboard test
- Input doubling in `confirm()` — readline listener save/restore
- SearchCode grep `--include` flag only emitted with `file_glob`
- Dangling edge in perception extractor

## [0.2.0] — 2026-06-01

### Added
- Multi-agent orchestrate mode (Researcher → Coder → Reviewer)
- Sub-agent spawning with isolated workspaces
- Circuit breaker and rate limiter for API resilience
- Provider fallback chains
- Session store with persistent history
- Web server with WebSocket real-time chat UI
- Bash completion support

### Changed
- Improved test suite to 734+ tests

## [0.1.0] — 2026-05-15

### Initial Release
- Single-agent loop: read → plan → execute → verify
- Multi-provider support: Claude, GPT, Gemini, Ollama
- 10 tools: read, edit, write, search, shell, test, git, spawn, web_fetch, web_search
- Three permission modes: normal, read-only, auto
- Interactive REPL with model switching
- TypeScript strict mode, MIT license

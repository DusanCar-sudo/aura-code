# Changelog

All notable changes to Aura Code are documented here.

## [0.10.5] — 2026-07-17

The Ruby Principle release: the local+cloud alternation layer is now wired
into both execution paths, gated by real verification, and controllable at
runtime.

### Added
- **RubyAlternator wired into the CLI single-task path.** `aura "<task>"` now
  routes through the alternator when `.aura.json` has `ruby.enabled: true` —
  a small local Ollama model attempts the task first, escalating to the large
  model on failure.
- **RubyAlternator wired into the TUI/REPL path** with abort support
  (Ctrl+C forwarded into both inner agent loops), shared context-health
  tracker, session history, and the session's real permission system —
  the Ruby attempt can no longer auto-approve operations the user's mode
  would have prompted for.
- **Verification gate on Ruby answers.** Before a Ruby result is trusted, a
  single no-tools `complete()` call to the large model judges whether the
  answer actually addresses the task (`VALID` / `INVALID: <reason>`). Catches
  confident-but-wrong drift, not just crashes and empty output. Fail-safe:
  any verification error counts as invalid and escalates.
- **`:rubyon` / `:rubyoff` REPL commands** — session-scoped runtime override
  of `.aura.json`'s `ruby.enabled`, following the existing
  `ReplCommandResult` state pattern. Registered in the Ctrl+P command
  palette and `:help`.
- **Standalone live kanban server** (`src/kanban/`) — agent-agnostic HTTP API
  + WebSocket board with MCP tool wrappers and three agent-worker lanes.

### Changed
- **Ruby local model switched to `granite4.1:3b`** (IBM Granite 4.1, 3B) via
  Ollama — notably accurate for its size in testing. The shipped code default
  (`DEFAULT_RUBY_CONFIG`) remains `qwen2.5-coder:1.5b`; set `ruby.modelName`
  in `.aura.json` to use Granite.

### Fixed
- **Provider prefix routing** — `zen/`, `nvidia/`, `groq/`, `gemini/`,
  `huggingface/`, `kimi/`, `qwen/`, `minimax/`, `stepfun/`, `fireworks/`,
  `upstage/`, `arcee/`, `tencent/`, `gmi/`, `kilocode/`, `alibaba/` prefixes
  now resolve to their providers.
- **Giant tool results no longer poison context** and defeat compaction.
- **Provider key management in `:provider` selector** with 401/403 recovery.
- **Severe local-model prefill slowness under Ollama's Vulkan backend on AMD
  iGPUs** — Vulkan prefill throughput was far below CPU on this hardware,
  making local-model calls hang for minutes. Environment-level fix (run
  Ollama CPU-only via `GGML_VK_VISIBLE_DEVICES`); guidance documented in the
  README's Ruby Principle section.

## [0.10.1] — 2026-07-11

### Fixed
- **Anthropic prompt cache stat propagation.** `toCachedSystem` and `toCachedTools`
  already marked system prompt and tool definitions with `cache_control: ephemeral`,
  but the provider silently discarded `cache_read_input_tokens` from API responses.
  Both the non-streaming (`fromAnthropicResponse`) and streaming paths now extract
  `cachedTokens` into `LLMResponse.usage`, so `costFor()` applies the discounted
  cache-hit rate on subsequent turns. `AURA_DEBUG_CACHE` logging now covers both
  paths. 3 new tests cover: cache read extraction, zero-cache omission, and
  absent-field omission.

### Added
- **Getting started guides** (English + Vietnamese): `Aura_Code_Getting_Started_EN.pdf`,
  `Aura_Code_Getting_Started_VI.pdf`.

## [0.10.0] — 2026-07-10

The headliner: TUI v2, Anthropic prompt caching, and a batch of model-selector
and Telegram fixes that make the daily workflow noticeably smoother.

### Added
- **TUI v2** — bottom-input layout with command palette, diff view, and
  inline markdown renderer. Vim-style modal scrollback (INSERT/SCROLL modes)
  on an isolated alt screen with a 5-row input box.
- **Anthropic prompt caching.** System prompt and tool definitions are wrapped
  with `cache_control: ephemeral` breakpoints so subsequent turns in the same
  session reuse the cached prefix (cost stat propagation deferred to 0.10.1).
- **Telegram `/status`** — shows the chat's live tasks and pending approvals.
- **Telegram `/stop` and `/approve-all`** — abort a running task, flush
  pending confirmations in one command.
- **Telegram voice-note replies** — audio policy: text always, audio for
  substantial answers.
- **Doctor: repo-root hygiene guard** — detects and warns about stray files
  that don't belong in the aura-code root.
- **Checkpoint safety** — files containing secrets are now excluded from
  checkpoint snapshots.
- **Relevance-gated tool definitions** — conditional tool definitions reduce
  per-request token cost by only emitting tools the model is likely to need.

### Fixed
- **Model selector: section headers no longer consume selector numbers.**
  Choosing a model from a section with a header line now resolves correctly.
- **Model selector: stale `apiKey`/`baseUrl` persisted across provider
  switch.** Cross-provider `:model` changes now clear old credentials and
  persist the correct `apiKeyEnv`.
- **TUI: input leaked during `:model`/`:provider` wizard.** Keystrokes now
  reach the wizard prompt instead of the main input.
- **Telegram TTS: stray CRLF prefix corrupted audio output.** Voice replies
  are now clean.
- **Display: improved contrast for code/log block text.**
- **Benchmark: scratch directory moved outside the repo** with git-isolated
  workdirs.
- **Memory: recently-updated identity entries prioritised** when truncating.
- **Setup wizard: `askInputFn` param** added to `selectProvider`/`selectModel`
  signatures for TUI integration.
- **Agent loop: sync final 3-line diff** from share copy port.

### Removed
- **Learnlight module** — broken/unused workflow abstraction, deleted.

## [0.9.0] — 2026-07-09

The arc of this release: a week-long audit found six complete, tested
subsystems that had never been wired into anything. All six are now live,
the safety layer they exposed a hole in is patched, and the self-checking
spec that kept false-failing on line drift is fixed at the root.

### Added
- **MCP client — Aura can connect to any MCP server.** `src/tools/mcp.ts`
  (a full stdio MCP client: `connect`/`disconnect`/`list_tools`/
  `call_tool`/`list_servers`) existed, tested, but was absent from the tool
  registry. Now registered: any MCP-ecosystem server (GitHub, databases,
  Puppeteer/Playwright browser automation, …) becomes callable mid-task
  with no integration code. Safety model: `connect` requires y/N
  confirmation in normal mode (like `run_shell`), dangerous spawn patterns
  are blocked in **all** modes including `--auto`, read-only mode blocks
  `mcp` entirely, and the trust boundary is the connection — an approved
  server's tools run via `call_tool` without further per-call prompts.
- **`:ecclesia <topic> [--panel <model>] [--seats <n>]`** — the 5-agent
  independent research council (`src/research/council.ts`): N agents
  research a topic without seeing each other's findings, one synthesis
  call reconciles them into convergent/contested/minority/verdict, saved
  to `council/*.md|.html`. Live-tested end-to-end (the first runs caught
  two real bugs — see Fixed).
- **`:mine [--refine]`** — experience mining (`src/mining/`): zero-LLM
  keyword clustering over `episodes/*.json` (Baby Ruby), with `--refine`
  running one local-model judgment per qualifying concept (Papa Ruby) and
  appending accepted lessons to `training-data/<date>.jsonl`.
- **`npm run repair-anchors`** — explicit, deliberate re-anchoring of the
  `:machina` AAM spec's line numbers (never a side effect of verification).
- **TUI rebuild** — vim-style modal scrollback on an isolated alt screen
  (INSERT/SCROLL modes, mode indicator), 5-row input box, Try-only sidebar.
- **Skills catalog** — AntV chart/infographic skills (antv-s2-expert,
  chart-visualization, infographic-creator) and the website-design stack
  (frontend-design, webapp-testing, accesslint-{scan,diff,audit},
  theme-factory).

### Fixed
- **`mcp connect` bypassed the permission system.** `PermissionSystem`
  special-cased only `run_shell`/`write_file`; every other tool fell
  through to default-allow — so spawning an arbitrary MCP server process
  needed no confirmation in normal mode and skipped the dangerous-pattern
  screen even in `--auto`. Now gated with the same screening as
  `run_shell` plus an unconditional confirm at connect.
- **`mcp call_tool` accepted tool names the server never advertised.**
  Follow-up to the live `:ecclesia` review's minority signal (servers can
  expand their tool list post-connect via `tools/list_changed` with no
  re-prompt): the connect-time `tools/list` snapshot is now enforced as an
  allowlist — unadvertised or later-added tools are refused client-side,
  and adopting a server's new tools requires disconnect + reconnect, which
  re-prompts. Documented residual gap: this constrains what Aura will
  request, not what a hostile local server process can do on its own.
- **AAM claims false-failed on pure line shifts** (three times in one
  week). Line anchors are now lookup hints: content found elsewhere in the
  file reports as `drifted` (passing, with recorded → actual line);
  only content genuinely missing from the file fails.
- **Ecclesia panel agents all hit 401s** — panel model resolution fell
  back to the provider instance's prefix-stripped model id
  (`deepseek-v4-flash`), which re-resolved through the generic
  OpenAI-compatible provider (wrong endpoint). The session's configured
  routing id is now threaded through.
- **Ecclesia synthesis fabricated a council from nothing** — agents that
  hit their turn cap returned "Loop ended after 6 turns." as their
  findings, and the synthesis model invented agent positions and sources
  from those five empty markers. The panel now salvages each agent's last
  real message, and agents with no output are reported honestly.
- **`findChrome()` returned symlinks** (`/usr/bin/google-chrome`) that
  Puppeteer can't launch — now resolved via `readlink -f`.
- **`dic` hung on some OpenAI-compatible endpoints** (e.g. Xiaomi MiMo
  Token Plan) — the SDK's default keep-alive agent is replaced with a
  plain `https.Agent({ keepAlive: false })`.

### Changed
- **Repo hygiene** — the repo root now contains only aura-code itself.
  Personal/utility material (presentations, one-off pages, video projects,
  the tracked `miscellaneous/` snapshot dump, zero-byte artifacts) moved
  out to a sibling `projects/` tree; standing rule established that new
  non-aura work never lands in the repo root.

### Tests
- Full suite: **1331 passing, 0 failures** (95 files), up from 1317 —
  +6 for the mcp permission gate, +8 for AAM anchor drift/repair.

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

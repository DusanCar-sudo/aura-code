# Changelog

All notable changes to Aura Code are documented here.

## [Unreleased]

## [0.14.0] — 2026-08-02

### Added
- **Claim-type-aware verification.** The Archimedes verification gate now distinguishes
  retrieval tasks (strict tool-evidence corroboration) from design tasks (factual
  premises still strict, novel proposals judged on coherence/relevance). This fixes
  a structural bias where good designs were penalized for lacking tool evidence.

- **Design council escalation.** When a design task fails large-model verification,
  it can escalate to a 5-agent design council that generates divergent solution
  proposals with tradeoffs, then synthesizes them into a structured recommendation.
  Council only fires when large-model verification fails AND the session budget allows
  the estimated 80k token cost.

- **SessionBudget integration into ArchimedesAlternator.** The alternator now
  respects the session token budget, checking before council escalation and
  skipping with a warning if the budget would be exceeded.

### Changed
- `runCouncil()` in `src/research/council.ts` now accepts a `mode` parameter
  (`'research'` | `'design'`) to switch between convergent truth-finding and
  divergent solution generation prompts.

- `AlternatorOptions` interface now includes optional `sessionBudget` parameter
  for cost control during council escalation.

### Fixed
- **Fabrication regression guard.** The original fabrication case (answer describes
  a nonexistent function that `search_code` returned nothing for) is still caught
  as INVALID after the design-aware verification changes. Factual premises in
  design tasks remain strictly verified — fabrication-under-cover-of-proposal is
  explicitly prevented.

## [0.13.5] — 2026-07-29

Versions step by 0.0.5 from here on: 0.13.5, 0.14.0, 0.14.5, and so on.

### Added
- **`:gazelle` and `:coder` work in the ordinary REPL again.** Restored
  unchanged from v0.13.1, which was withdrawn on suspicion of causing a task to
  loop on one step. It wasn't: 0.13.0 traced that to `step-3.5-flash` collapsing
  into repetition inside a single streamed reply, with nothing in the harness to
  stop it. The mode branch never ran in coder mode — it was inert while
  `replMode === 'coder'`, and the coder path beneath it was untouched — so with
  the real cause fixed there is nothing left to hold it back.

  `:help` and the README have advertised both commands since Gazelle landed,
  while only the `--gazelle` orchestrator implemented them; typed into the plain
  REPL they fell through the command handler and were sent to the model as a
  *task*. Now the TUI switches in place: the machinery of a Gazelle turn lives in
  `agent/gazelle-chat.ts`, independent of how input arrives, so the TUI can drive
  it without opening a second readline on stdin it already holds in raw mode
  (two readers on one stream double every keypress). Lean turns share the REPL's
  conversation — carried both ways, coder tool noise stripped on the way in —
  count against the session token ceiling, and appear in `/stats`; the status
  line gains a `gazelle` marker. A mode switch or second message arriving while a
  reply is still streaming waits for it rather than interleaving two
  conversations into one history.

  The commands live in `cli/repl-mode-commands.ts` because nothing in
  `cli/index.ts` can be imported by a test, which is how a command stayed
  advertised and unimplemented without anything going red. One of the tests walks
  `:help`'s Modes section and asserts every command it lists is handled.

## [0.13.0] — 2026-07-29

Carries the RTK token work from 0.12.9 plus the fix below. Briefly tagged
`v0.12.10` before being renumbered; same content, no npm release under that
number.

### Fixed
- **A reply that collapses into repeating one phrase is now cut off, not paid
  for to the last token.** `stepfun/step-3.5-flash`, asked to build a large HTML
  page, narrated `Writing the HTML structure... ` several hundred times, spent
  its entire 16,384-token output allowance, returned `stopReason: 'limit'`, and
  the run ended having written nothing. It reproduced on every attempt in the
  session. Nothing in the harness noticed: text chunks were appended and printed
  regardless of what they contained, and the only backstop was the model's own
  output cap.

  `agent/repetition-guard.ts` watches the stream's tail for an exactly periodic
  cycle — which is what a collapsed model emits, and what ordinary prose never
  does — and trips after ~1,200 characters of it. The loop then:

  - **stops reading**, which returns the generator and aborts the HTTP request,
    so the provider stops generating (and billing) the remaining output. The
    openai-compatible adapter had no cleanup on early exit; it now aborts its
    controller in a `finally` unless the stream drained normally;
  - **keeps the loop out of history** — only the text from before the collapse
    survives, plus a one-line marker. A model shown even a few copies of its own
    loop carries on with it, which is why every later turn in that session
    repeated too;
  - **retries with the failure named**, telling the model to make the
    `write_file` call it was narrating instead of describing it. Twice, then it
    gives up and says plainly that this is a model failure and suggests a
    stronger `--model`, rather than implying the task was at fault.

  `AURA_REPETITION_GUARD=0` disables it. The thresholds are set so ordinary
  output cannot reach them, but nobody should have to wait for a release to
  switch off something that truncates replies.

  Two compaction fixtures used `'y'.repeat(10_000)` as filler and now trip the
  guard on purpose — a model emitting ten thousand identical characters is
  exactly this bug. They use varied prose of the same length instead; the token
  volume they depend on is unchanged.

## [0.12.9] — 2026-07-29

Supersedes **v0.13.1**, which was tagged earlier the same day and withdrawn —
see "Reverted" below. This release is v0.13.1 minus the REPL mode switch: the
RTK token work and the Telegram search verb, nothing else.

### Reverted
- **`:gazelle` / `:coder` in the plain REPL is withdrawn.** Shipped in v0.13.1;
  pulled after a coder-mode task looped on one step ("Writing the HTML
  structure…" repeated until it hit the token ceiling, ending after 7 turns).
  The mode branch is inert while `replMode === 'coder'` and the coder path was
  unchanged beneath it, so the loop is probably not from this — but a release is
  not the place to find out. `:coder` and `:gazelle` again work only inside a
  session started with `--gazelle`; in the plain REPL they are unhandled and get
  sent to the model as a task, as before. Under investigation; RTK's compression
  of `run_shell` output is the first suspect, since a model that cannot see
  whether a write landed will retry it.

### Changed
- **Shell and git tool output now goes through RTK — 80% fewer input tokens per
  session.** RTK was installed on the machine, but its Claude hook only rewrites
  commands typed at a terminal. Aura's own tools shell out through Node's
  `exec`/`execSync` directly, so `run_shell`, the `git` tool, and the Telegram
  bot's `execShell` bypassed the proxy entirely: raw `git diff`, `git log` and
  `grep` output landed in the context window uncompressed, and the bloat
  compounded as a session grew. Each of those call sites now prefixes `rtk `
  (skipped when the command already starts with it), and `gitStatus`/`gitDiff`
  invoke `rtk git …` explicitly.

  Measured over the same three tasks — an uncommitted-changes review, a
  TypeScript compiler-API audit, and a changelog web page build — run four times
  as the patches went in:

  | Run | State | Input tokens | Turns | Tool calls |
  |---|---|---|---|---|
  | 1 | no RTK (raw node exec) | 1,286,806 | 40 | 60 |
  | 2 | `telegram-bot.ts` patched | 946,293 | 39 | 70 |
  | 3 | `tools.ts` patched | 397,519 | 16 | 28 |
  | 4 | fully optimized | **253,039** | **13** | **23** |

  80.3% fewer input tokens and 67.5% fewer turns for identical work. Compressed
  summaries don't just cost less than raw terminal noise — the model converges
  faster on them. Full write-up in `rtk-optimization-report.md`.

  **RTK stays optional.** Prefixing unconditionally would have made it a hard
  runtime dependency of a published package — every `run_shell` call on a machine
  without it returning "rtk: command not found". `util/rtk.ts` probes `PATH` once
  per process (a filesystem scan, no `which` subprocess) and passes the bare
  command through when RTK isn't there. `AURA_RTK=0` forces the raw command even
  when it is installed, which is what you want when checking exactly what a tool
  ran; `AURA_RTK=1` skips the probe.

### Added
- **`SEARCH:` for the Telegram bot.** The bot could run shell commands, send
  files and take webcam stills, but had no way to look anything up — so it
  answered questions about current events from stale weights, or claimed it
  could not search at all. `SEARCH: <query>` now hits DuckDuckGo's lite HTML
  endpoint (no API key, no SDK) and returns the top five titles, URLs and
  snippets. The action prompt tells the agent to reach for it first when it
  lacks up-to-date information, and the "never claim you cannot…" instruction
  now covers searching alongside sending and photographing.

## [0.12.2] — 2026-07-27

### Added
- **Cumulative token ceiling now covers the plain REPL session.** Previously
  only the gazelle orchestrator's coder-conversation path held a
  `SessionBudget`; the REPL passed none, so `recordTurn`/`recordCall` were
  no-ops and net-of-cache spend was never tracked across messages. One budget
  now lives for the life of the REPL process.

  Turn-count enforcement is deliberately **not** extended here. The
  per-invocation `maxTurns` guard already holds correctly in the REPL, and a
  cumulative turn cap is the wrong instrument for interactive use where a
  human types every message and watches every response. Measured on a real
  96-minute session — 58 turns across 9 messages, 86% cache hit rate, $0.50
  total, peak 19 turns in any single message — a 50-turn session cap would
  have interrupted that for crossing a count that said nothing about its cost.

### Fixed
- **TUI: SS3-encoded arrow keys corrupted the input and flipped the screen.**
  Terminals in application-cursor mode send `\x1bOA` for Up. The input parser
  handled CSI (`\x1b[A`) but not SS3, so the sequence fell through to the
  bare-Escape branch: Escape entered scroll mode and the remaining `O` and
  final letter were typed into the input as literal text. Pressing an arrow
  key could flip the display to the scroll view and inject garbage.

  This is very likely the real cause of the "response stalled, then typing
  fixed it" reports — the live view was frozen in scroll mode, not the network
  connection. Typing a printable character exits scroll mode and redraws,
  which is exactly the observed "fix". Normalized the same way
  `context-tuner.ts`'s `splitKeys` already did, including waiting for the
  final byte when the sequence is split across reads.
- **TUI: typing `q` to leave scroll mode silently dropped the character** — a
  word beginning with "q" lost its first letter. `q` was excluded from the
  printable-exit path but advertised nowhere. `i` remains excluded on purpose:
  the scroll indicator documents "i/Enter/Esc insert", so it is a deliberate
  vim-style command.
- **TUI: terminal resizes during an overlay were dropped entirely.** While a
  command palette, session switcher, context tuner, or confirmation prompt
  held the screen, `handleResize` returned early and the event was lost,
  leaving the scroll region set to the old geometry once the overlay closed.
  The resize is now recorded and applied when input resumes.

### Known follow-ups (not in this release)
- **ESC timeout.** A lone Escape stays buffered until the next byte arrives,
  so pressing Esc alone does nothing until another key is pressed. Fixing it
  needs a ~25–50 ms timer to disambiguate Escape from the start of a sequence;
  a fixed timeout can misfire on slow terminals and high-latency SSH, so it is
  deferred to its own pass rather than rushed into a patch release.
- **Archimedes alternator has no budget wired in at all.** `alternator.run()`
  accepts no budget in its options interface, so neither ceiling applies to
  that path. Closing it needs a signature change.

### Fixed (previously unreleased)
- **`npm test` sent a real Telegram voice message and overwrote a real API
  key.** Two tests reached outside their sandbox on any machine with a
  configured bot:

  `tests/telegram-voice-live.test.ts` was gated `skipIf(isCI || !hasTelegramConfig)`
  — it skipped on CI and ran everywhere else, firing a live voice note at
  `telegram.json:default_chat_id` on every run. The sends left no trace in the
  bot's journal or session history (they came from the vitest process, not the
  bot service), which made them look like unexplained "the bot keeps sending me
  audio every few hours" behaviour. Now opt-in via `AURA_LIVE_VOICE_TEST=1`,
  and it requires an explicit `AURA_TEST_CHAT_ID` rather than falling back to a
  real person's chat.

  `tests/provider-wizard.test.ts` isolated `XDG_CONFIG_HOME` but not
  `os.homedir()`, which is what `key-store.ts` uses — so `saveKey()` wrote the
  fixture `sk-test-key` into the developer's real `~/.aura/keys.json`,
  replacing their DeepSeek credential. It now mocks `os.homedir()` like the
  other filesystem-touching tests.


- **Streaming responses could hang forever on cloud providers.** An SSE stream
  can go silent without the TCP connection closing — no error, no terminating
  chunk, the read simply blocks on data that never arrives. Aura waited
  indefinitely and showed the user nothing.

  The SDKs do not cover this, despite appearing to. Both `openai` and
  `@anthropic-ai/sdk` default to a 600s `timeout`, but implement it as
  `fetch(...).finally(() => clearTimeout(timer))` — and the fetch promise
  settles when response *headers* arrive, which for a stream is immediate. The
  timer is cancelled before a single chunk of the body is read, so the
  documented timeout covers time-to-headers and nothing else.

  Streams are now guarded by an idle timeout measured *between chunks*
  (`src/providers/stream-timeout.ts`), default **60s**, applied to both the
  OpenAI-compatible and Anthropic paths. Total-duration limits would be the
  wrong tool: a legitimate turn can run for minutes through tool calls, but a
  healthy stream never goes quiet for long once tokens flow. 60s was calibrated
  against 529 consecutive-turn intervals from this project's own token log
  (median 3.9s, p90 27s — and those measure whole turns *including* tool
  execution, so real inter-chunk gaps are far smaller).

  On a stall the underlying request is aborted, so the socket is released
  rather than leaked. The request is retried once, but **only when nothing has
  reached the consumer yet** — after text has been yielded the agent loop has
  already accumulated and displayed it, and re-running would append a second
  full response, corrupting both the transcript and the token accounting. In
  that case the stall surfaces as a clear provider error instead of hanging.
  This mirrors the existing rule in `resilient.ts`, which retries acquisition
  of the first chunk but never a mid-stream failure.

  Override with `AURA_STREAM_IDLE_MS` (values below 5000 are floored; `0`
  disables the guard entirely).

## [0.12.1] — 2026-07-26

### Added
- `/ct` as a short alias for `/context tune`.

### Fixed
- `/context tune` reported each rung's threshold as an uncapped share of the
  context window, ignoring `context.maxTokens`. On a 1M-window model it showed
  `rung 1: 55% (550.0k)` while compaction actually fired at the 80k cap — the
  same engine/display disagreement `context-policy.ts` was created to prevent,
  reintroduced in the tuner. Rungs held at the cap now show the effective
  token value marked `— capped`, and the tuner says outright when every rung
  is above the cap and moving them can have no effect.

## [0.12.0] — 2026-07-26

Cost controls. Prompted by a session that spent 27M input tokens over 216
calls and compacted zero times: every guard meant to stop that either measured
the wrong unit, reset before it could bind, or priced the result wrong
afterwards. This release fixes the measurement, the ceilings, and the
reporting, and deletes two features that were never wired up.

### Added
- **Session-level spend budget** (`src/agent/session-budget.ts`) — cumulative
  turns *and* cumulative input tokens net of prompt-cache hits, tracked across
  a whole conversation rather than per `runAgentLoop` call. A coder
  conversation calls the loop once per user message, so the turn counter used
  to restart at 1 on every segment while history kept growing: a 30-turn cap
  on a three-segment conversation still permitted 90 turns. Net-of-cache is
  the meaningful ceiling, since cache hits bill at a fraction of the standard
  rate (GLM-5.2: $0.26 vs $1.40 per Mtok) and a raw-token ceiling would stop a
  cheap well-cached session and an expensive cold one at the same point.
  Default input ceiling 1M tokens; advisory, not a hard abort — the loop
  finishes its turn and returns, so the session stays resumable.
- **Absolute compaction cap.** The compaction ladder was a *share of the
  context window*, which is the wrong unit for a cost control — on glm-5.2's
  1M window, rung 1 sits at 550k, so a session growing to 218k never compacted
  once. Threshold is now `min(window * rung, maxContextTokens)`, default 80k:
  a no-op where things already worked (at a 128k window rung 1 is 70.4k, below
  the cap), binding only on 200k/1M-window models. Replaying the investigated
  session's real per-call deltas: 32.6M → 14.9M input tokens, 7 compactions
  instead of 0. Retention is additionally clamped to 75% of the actual trigger,
  since it was window-relative too and would otherwise have re-fired every turn.
- **`/cost [n]`** (`src/cli/cost-report.ts`) — cache hit rate and cost per
  call over `.aura/token-log.jsonl`, including what the same input would have
  cost at a 0% hit rate. Cache hit ratio is the dominant cost lever and was
  invisible at runtime: one session carried 7.75M tokens uncached at $7.90,
  then 19.5M tokens at 98% cached for $1.04 — same work, 7.6x cheaper — with
  nothing in the CLI surfacing the difference while it happened.
- **`/context tune`** (`src/cli/context-tuner.ts`) — arrow-key editor for the
  compaction ladder with a live token readout, rungs clamped so they can't
  cross. Keyboard rather than mouse, deliberately: SGR mouse mode would
  disable native text selection for the whole session.
- `.aura.json` gains `context.ladder` and `context.maxTokens`.
- One-shot REPL nudge when inherited history crosses the compaction threshold,
  pointing at `:new` / `:clear-history`. The investigated session was 8
  separate tasks sharing one 218k-token history.

### Changed
- **Default turn cap 150 → 50.** The shape-based ladder (30 / widen-80 / 80 /
  150) is replaced by one flat cap. Sizing a cap off task-shape guesses meant
  `DEFAULTS.maxTurns` flowing through `resolveConfig` was indistinguishable
  from an explicit `--max-turns`, silently disabling the smaller ceilings it
  was meant to enforce. Expect `--max-turns` to be routine for real project
  work now, not just benchmark runs.
- `/clear` and `/reset` now state that they do **not** clear conversation
  history. Sitting next to `:clear-history`, which does, the naming was a
  costly footgun.
- The compaction ladder was duplicated in `compactor.ts` (what fires) and
  `context-health.ts` (what the bar draws); both now read from
  `context-policy.ts`, so the footer can't report thresholds the engine isn't
  using.

### Removed
- **`src/kanban/`** (8 files, tests, and `docs/KANBAN-MANUAL.md`) — documented
  as `aura kanban` but never wired into the CLI, with no imports from anywhere
  in `src/`. Removed as dead code rather than finished.
- **`src/archimedes/fine-tune.ts`, `src/archimedes/training-data.ts`** and
  their re-exports from `archimedes/index.ts` — no call sites. Episode
  capture, competence routing, and `:mine --refine` (which writes its own
  `training-data/*.jsonl`) are unaffected.
- `src/providers/anthropic-oauth-draft.ts` — unused draft.
- ZenMux provider support, reverted along with the bare vendor-id routing it
  depended on.

### Fixed
- **Cache accounting for every OpenAI-compatible provider except DeepSeek.**
  Only DeepSeek's `prompt_cache_hit_tokens` was read; the OpenAI-standard
  `prompt_tokens_details.cached_tokens` (used by Zhipu/GLM and most vendors)
  was parsed nowhere, so cached prompts were billed at the full rate —
  overstating cost up to ~10x on a cached turn and making it impossible to
  tell whether caching worked at all. Verified end-to-end against live
  DeepSeek traffic, where both dialects agree.
- **GLM pricing** in `PRICING_USD_PER_MTOK` — real published Zhipu rates for
  `glm-5.2`/`glm-5.1`/`glm-5`, each now with a `cachedIn` entry instead of
  falling back to an `input/10` guess. `glm-5-turbo` was missing entirely and
  costed at $0; it is now priced.
- **Reasoning-model content in the OpenAI-compatible path**
  (`src/providers/reasoning.ts`). Local reasoning models emit chain-of-thought
  to a separate `delta.reasoning` / `reasoning_content` field via Ollama's
  `/v1` endpoint. The provider read only `delta.content`, so a response that
  spent its whole token budget mid-thought rendered as empty. Both spellings
  are now read, `<think>` tags are stripped, and the reasoning trace is used
  as the answer when content is genuinely absent. Applies to all local
  reasoning models via `/v1`, not just Archimedes.
- `[cache]` debug output no longer printed on every stream chunk.

## [0.11.0] — 2026-07-25

The Gazelle release: a lean conversational path alongside the coding agent, so
the cheap 90% of what you say to Aura stops paying the coding agent's price.

### Added
- **Gazelle mode** — a lean conversational path alongside the coding agent.
  No tool schemas, no project context, no Archimedes, no verification gate.
  Launch with `--gazelle`, `--mode gazelle`, or `AURA_MODE=gazelle`.

  Measured on this repo with Aura's own tokenizer (`estimateContextTokens`),
  the fixed per-turn context drops from **9,367 tokens** (4,793 system prompt +
  project context, 4,574 for 25 tool schemas) to **356** — a **26x** reduction,
  9,011 tokens saved on every single turn. Cumulative savings across a whole
  conversation are much larger, since the coding agent's history also
  accumulates file contents and tool output, but that multiple depends entirely
  on how many tools a given session calls — it is not a fixed spec.
- **Session-end conversational memory** — a rolling situational summary written
  when a Gazelle session ends, giving continuity across sessions without a
  visible memory dump. Gazelle uses it as background knowledge rather than
  announcing it.
- **Bidirectional mode switching** — `:coder` hands off to the full coding
  agent, `:gazelle` drops back to the lean path, and conversation history
  carries across in both directions. Gazelle also recognizes when a request
  needs tools and offers to switch on its own, detected from its own response
  text via a regex rather than an extra classifier call, so the detection costs
  nothing per turn.
- `.auraignore` — one glob per line; matching directories are excluded from the
  project tree sent to the system prompt. Mirrors `.rgignore`, which governs
  search instead.
- Archimedes now sees only read-only tools during its attempts (`read_file`,
  `list_dir`, `search_code`, `search_semantic`) instead of the full registry,
  cutting the tool-schema cost of every Archimedes turn.

### Fixed
- `maxTurns` was not propagated from CLI flags into `ArchimedesAlternator` or
  the large-model escalation fallback, so a single question could run far past
  `--max-turns` and consume turns (and tokens) that had been explicitly capped.
- Telegram bot (`aura-telegram.service`) pinned a CPU core at 100% on every
  start and never came up. The unit ran `npx tsx src/tools/telegram-bot.ts`,
  but `tsx` is neither a dependency nor present in `node_modules` — so npx
  resolved and installed it from the network on each start, burning ~110s of
  CPU per 110s of wall clock and growing `~/.npm/_npx` to 3.1 GB, while the bot
  never reached its startup banner. It now runs the compiled build with plain
  `node` (see "Telegram bot service" in the README): startup is under a second
  at 0.2s CPU. A `Restart=on-failure` / `RestartSec=15` policy with a 5-in-5min
  retry cap was added as a guard, though the bot's poll loop already handles
  409 Conflicts in-band and never exits on them.
- Telegram bot `/help` was Serbian while the rest of its output was English; it
  is now English throughout. Its startup banner also resolved the bot name from
  a hardcoded string, which could name the wrong bot after a token change — it
  now reports the identity `getMe` returns.

### Changed
- Google provider calls `generateContent` / `generateContentStream` directly
  instead of building a `startChat` session and replaying history into it,
  which removes a redundant split of the last message from the rest of the
  conversation on every request.
- **The small-model alternator is renamed from "Ruby" to "Archimedes".**
  The name "Ruby" meant three things at once (the programming language in
  `src/orchestration/ruby-detect.ts`, the pre-Aura product persona, and the
  small-model alternation layer); the alternator now carries its own name.
  "Archimedes Principle" is deliberate: a small model displaces work from the
  large one once it has proven competent, the way a body displaces its own
  weight. Renames: `src/ruby/` → `src/archimedes/`, `RubyAlternator` →
  `ArchimedesAlternator`, `RubyConfig` → `ArchimedesConfig`, `RubyModel` →
  `ArchimedesModel`, the `.aura.json` `ruby` block → `archimedes`, and the
  REPL commands `:rubyon`/`:rubyoff`/`:rubymodel` →
  `:archon`/`:archoff`/`:archmodel`. The old `ruby` config key and old
  episode field names (`rubyAttempted`, …) are not migrated — new keys going
  forward. Ruby-the-language detection is untouched. Entries below this one
  keep their original "Ruby" wording — they describe the code as it was.

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

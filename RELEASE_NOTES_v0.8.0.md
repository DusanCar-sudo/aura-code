# v0.8.0 — Voice, unified memory, and a capable (and secured) Telegram Aura

Aura gains a full two-way voice loop, one shared memory across the CLI and the
Telegram bot, and a Telegram bot that can genuinely act on the machine — with a
proper security layer in front of it. Plus a batch of root-cause fixes for the
recurring provider/key pain.

## 🎙️ Voice — talk to Aura, and she talks back

- **`dic toggle`** — one-hotkey dictation built for a global shortcut: tap to
  start recording, tap again to transcribe and type straight into the focused
  window (with Enter). No relaunch, no Ctrl+C per turn.
- **Aura speaks her replies** — `--speak` flag / `:speak` toggle reads task
  summaries aloud (MiMo TTS), so a whole exchange can be hands-free.
- **GLM-ASR** wired as an opt-in speech provider (`DIC_USE_GLM_ASR=1`), with a
  resilient STT fallback chain (any provider failure falls through to the next).
- Injection types characters (wtype → ydotool → xdotool) instead of a fake
  Ctrl+V, so text lands correctly in terminals.

## 🧠 Unified memory (CLI ⇄ Telegram)

- One shared memory layer: **global identity/facts** (`identity.json`, deduped
  from 8 overlapping namespaces, conflicts preserved as CONFLICT entries) plus
  **lessons** — per-project reconciled dreams for the CLI, a global cross-project
  digest for the bot.
- `loadUnifiedMemory()` feeds both system prompts, so what one surface knows,
  the other knows too.
- `runGlobalReconciliation()` distills every project's episodes into a
  pure-statistics lessons digest (no LLM call).

## 🤖 Telegram bot — voice, PC control, files, camera

- **Listens & speaks** — transcribes incoming voice notes and replies with
  voice notes (OGG/Opus via curl, so they play with real duration).
- **Agentic PC control** — ask in natural language; the model runs commands
  (`RUN:`), sends files (`SEND:`), or takes a webcam snapshot (`CAM:`) and
  answers from real data.
- **`/cam`** — capture and send a surveillance snapshot from the integrated
  camera.
- Replies in the user's language (no longer always Serbian).

## 🔒 Security

- **User allowlist** — only `allowed_user_ids` may talk to the bot; everyone
  else is refused. (The bot can run shell commands, so this is the primary
  boundary.)
- **Command approval** — read-only inspection runs free; anything mutating
  (writes, installs, `sudo`, `git push`, `systemctl start/stop`, pipe-to-bash,
  or any unknown command) requires an explicit ✅/❌ approval. Deny-by-default.
- **`:approve`** in the CLI — `:approve all` / `:approve off` to control
  session-wide auto-approval. Catastrophic commands stay blocked either way.

## 🩹 Fixes (root-cause)

- **Global baseUrl no longer hijacks other providers' models** — the recurring
  "401 token expired" was the `:provider` wizard saving a provider-specific
  baseUrl globally; it's now only applied to its own default model.
- **Persistent API-key store** (`~/.aura/keys.json`, 0600) — stop re-typing keys
  every session; loaded into the environment at startup, `:apikey` persists.
- Top-anchored startup (logo pinned top-left) + a framed `ask aura` input field.

## Also

- OpenCode Go provider (Anthropic-style `/v1/messages` endpoint).
- Graphify custom-panels dashboard pipeline.

**951 tests passing.**

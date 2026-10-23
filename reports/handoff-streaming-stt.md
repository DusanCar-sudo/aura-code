# Handoff — Streaming STT for dic (auto-stop + partial transcripts)

**Goal:** Alt+X press once → transcribes while you speak → auto-stops on 2 s
of silence → text is ready by the time you stop. No second press, no waiting
for a 4–5 s cloud round-trip after you finish talking.

**Status:** designed, not started. This file is the full spec — pick it up in
any new session and build.

---

## Where things stand (2026-10-20)

- Aura-code agent (#1) carries the **most detailed implementation plan** for
  C#-free Node work: file layout, event order, VAD tuning, test plan.
- Parakeet q8 (669 MB) is downloading to
  `/mnt/bigdata/projects/voice/models-dl/` (log:
  `/tmp/opencode/parakeet-dl.log`, script
  `/mnt/bigdata/projects/voice/fetch-parakeet-models.sh`). Silero VAD
  v6.2.0 (1–2 MB) downloads right after to
  `/mnt/bigdata/projects/voice/whisper.cpp/models/ggml-silero-v6.2.0.bin`.
- Until Parakeet lands, implement with `local` stubbed (throw) and streaming
  Groq on top — the architecture is identical either way.

## Decision snapshot

- Primary loop: pw-record → PCM callback at 16 kHz mono s16le.
- Every 320 ms: RMS check (silence detector) + send audio chunk.
- Stop rule: consecutive silence ≥ 2.0 s (matches TALK_SILENCE) AND ≥ 0.45 s speech seen.
- Safety cap: 45 s max turn (TALK_MAX_UTTER).
- Streaming: `whisper-large-v3-turbo` on Groq (prompt vocab from `DIC_PROMPT`).
  Local Parakeet replaces it once downloaded.
- Injection: reuse `injectText()` (wtype; clipboard fallback). No Enter in terminals
  (aura-dic already handles app detection — keep that logic in the wrapper).

## Files to create

- `aura-code/src/cli/dic-stream.ts` — the loop (telemetry + debug enable flags via env `DIC_STREAM_DEBUG`).
- `aura-code/src/tools/stt-stream.ts` — provider interface: `openStream(opts) -> StreamHandle`.
  Two implementations: `groq-stream.ts`, `parakeet-local.ts` (later).
- `sway` binding change: `bindsym Mod1+x exec $HOME/.local/bin/aura-dic --stream`
  (aura-dic grows a `--stream` flag that just calls the new CLI entry; keep `toggle` as fallback).

## Groq streaming notes

- Groq's OpenAI-compatible chat endpoint accepts `input_audio` per-message; for a
  persistent connection model the audio as **a single "user" message per turn
  of ≤ 25 s of WAV**, chunked every 5 s, with server exchanging one response
  per message. If Groq rejects multiple audio messages, downgrade gracefully to
  `transcribeFile()` per segment: record 5–8 s chunks, transcribe, concatenate.
- Estimated latency to first tokens ≈ 1–2 s after the first chunk closes.
- Keep `--max-time 20` semantics (timeouts); on provider fail, fall back to
  current `normalizeAndTranscribe` chain, unchanged.

## Acceptance tests

1. `echo test | aura-dic --stream` types text without prompt; ends within 2.3 s of silence.
2. Recording aura-mic .wav through `stt-stream.ts` produces identical transcript as today's path (prompt applied).
3. Press Alt+X, speak 5 s, wait: a notification shows partial text within ~1.5 s, final text lands ≤ 0.5 s after silence.
4. Ensure `aura-mic` toggle still works (regression target).
5. Net new deps: zero if using only Node built-ins + OpenAI SDK already in aura-code.

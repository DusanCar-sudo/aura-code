# Aura → Inference Provider → Aura's Own Model

The three-phase path from "aura-code consumes other companies' models" to
"Aura runs its own model".

## Phase 0 — already done
aura-code already has a provider-agnostic model layer: `src/providers/`
(Anthropic, Google, OpenAI-compatible, custom `.aura.json` providers,
LM Studio / Ollama / any local endpoint), resilience and fallback
(`resilient.ts`), and cost tracking (`archimedes/`).

## Phase 1 — Aura Inference Gateway (built 2026-10-10)
`src/server/inference.ts` exposes an **OpenAI-compatible API inside
`aura serve`**, behind the existing auth token:

- `GET  /v1/models`
- `POST /v1/chat/completions` — `model` can be any model id aura-code
  routes (e.g. `deepseek/deepseek-chat`, a local LM Studio model), or
  `aura-1` / omitted → the server's default model.

One URL, one token, every model Aura can reach. Anything that speaks the
OpenAI wire format — scripts, apps, the phone client — can now use Aura
as its provider.

## Phase 2 — `aura-1` as a real virtual model
`aura-1` stops being an alias and becomes a **routing policy**: task/effort
aware routing across providers (cheap local model first, escalation on
failure or complexity), using `resilient.ts` fallback + `archimedes` cost
accounting. Users configure zero keys; Aura picks the brain per request.

## Phase 3 — Aura's own model
Fine-tune / distill a small open model (granite / Qwen class — the
granite-4-h-tiny endpoint already used by the Mnemai curator is the
prototype) on Aura conversation + memory data, served locally through
llama.cpp / LM Studio **behind the same gateway** as `aura-1-local`.
The gateway is what makes it a drop-in: clients never change code when
the model underneath changes.

## Revenue line this enables
Phase 1 makes Aura sellable as infrastructure ("your apps, our provider"),
phase 2 as a managed service, phase 3 as a defensible asset (the model is
trained on what only Aura has: agent interaction + memory data).

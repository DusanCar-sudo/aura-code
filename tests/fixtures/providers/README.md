# Recorded provider fixtures

Real responses, captured off the wire, replayed in tests.

## Why four fixtures cover thirty providers

Aura routes to roughly thirty vendors, but they do not speak thirty protocols.
They speak **four wire formats**, and a provider entry is just a base URL and a
key pointed at one of them:

| Transport class    | Wire format                                  | Who uses it |
|--------------------|----------------------------------------------|-------------|
| `anthropic`        | `/v1/messages`, Anthropic content blocks      | Claude |
| `google`           | `v1beta generateContent`, candidates/parts    | Gemini (AI Studio) |
| `openai-compatible`| `/chat/completions`, choices/delta            | ~27 vendors: OpenAI, DeepSeek, Zhipu, Groq, Qwen, Kimi, OpenRouter, BytePlus, … |
| `archimedes-local` | `/chat/completions` served by Ollama/LM Studio | the local small-model path |

Adding the thirty-first vendor adds a row to `PROVIDER_DESCRIPTORS`, not a new
parser. So the thing worth pinning is the format, not the vendor — a fixture per
class is what actually detects "a provider changed its wire format", which was
previously invisible until runtime because the tests mocked at the `fetch`
boundary with nothing recorded behind them.

`archimedes-local` is listed separately from `openai-compatible` even though
Ollama serves the same shape, because the local path has its own quirks worth
pinning (`fp_ollama` fingerprints, no `usage` on some builds, different error
envelope) and it is the one transport with no vendor behind it.

## What is captured

Three per class: a non-streaming completion, a streaming completion (raw SSE),
and one error response. Files are `<class>.<kind>.json`, each recording the
status, the endpoint it came from, and the capture timestamp.

## Refreshing

```bash
npm run fixtures:capture                    # every class whose credentials exist
npm run fixtures:capture -- google           # just one class
```

Requests are trivial ("Reply with the single word: pong") so a refresh costs a
fraction of a cent. API keys are redacted out of bodies on write.

A success capture that does not return HTTP 200 is **refused, not written** — a
402 stored under `nonstreaming` would let a lapsed account masquerade as a
recorded wire format, which is the exact failure fixtures exist to rule out.

## Current coverage

| Class | non-streaming | streaming | error |
|---|---|---|---|
| `google` | ✅ | ✅ | ✅ |
| `archimedes-local` | ✅ | ✅ | ✅ |
| `openai-compatible` | ❌ | ❌ | ✅ |
| `anthropic` | ❌ | ❌ | ❌ |

Gaps are real, not oversights, and the replay tests **skip** on a missing
fixture rather than passing:

- `anthropic` — no `ANTHROPIC_API_KEY` on the capture machine.
- `openai-compatible` success — both accounts with keys present (DeepSeek,
  Zhipu) returned "insufficient balance". The error fixture captured fine, and
  `archimedes-local` pins the same `/chat/completions` shape in the meantime,
  but a cloud success capture is still owed.

Run the capture command on a machine with those credentials and the table fills
in with no code change.

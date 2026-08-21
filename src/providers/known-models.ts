/**
 * The static model catalog and the merge that turns it into the list the
 * pickers actually show.
 *
 * Separated from factory.ts because the two answer different questions:
 * factory.ts decides *how to call* a model (transport, base URL, key), while
 * this decides *which models to offer*. They also change for different
 * reasons — the catalog below goes stale every time a vendor ships or retires
 * a model, and that churn should not touch the routing code.
 *
 * Reads the custom-provider registry through custom-registry.ts rather than
 * factory.ts, so there is no cycle. factory.ts re-exports KNOWN_MODELS and
 * getAllModels, so existing callers are unaffected.
 */

import { getLiveModels } from './live-models.js';
import { getCustomProviders } from './custom-registry.js';

/** One catalog row, as consumed by the `:model` picker and `--models`. */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  speed: string;
}

/**
 * List of well-known model shortcuts for quick selection.
 * Used by the `:provider`/`:model` selectors and by `--models` on the CLI.
 *
 * NOTE: Anthropic, OpenAI, Google, and OpenRouter entries here are a
 * fallback only — getAllModels() prefers live-fetched lists for these
 * four providers when available (see live-models.ts), since this static
 * list goes stale fast. As of Feb 2026, OpenAI retired gpt-4o, gpt-4.1,
 * gpt-4.1-mini, and o4-mini from the API. The Anthropic list below is
 * also behind the current lineup — Claude Sonnet 5, Claude Opus 4.8, and
 * Claude Fable 5 are the current generation as of this writing and are
 * not listed statically; live fetch is what surfaces them.
 */
export const KNOWN_MODELS: ModelCatalogEntry[] = [
  // ── Anthropic Claude ─────────────────────────────────────────────────────
  { id: 'claude-opus-4-5-20251001',   name: 'Claude Opus 4.5',   provider: 'Anthropic', speed: 'Powerful · strongest' },
  { id: 'claude-sonnet-4-5-20251001', name: 'Claude Sonnet 4.5', provider: 'Anthropic', speed: 'Fast · balanced' },
  { id: 'claude-haiku-4-5-20251001',  name: 'Claude Haiku 4.5',  provider: 'Anthropic', speed: 'Fastest · cheap' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', speed: 'Fast · legacy' },
  { id: 'claude-3-5-haiku-20241022',  name: 'Claude 3.5 Haiku',  provider: 'Anthropic', speed: 'Fastest · legacy' },
  { id: 'claude-3-opus-20240229',     name: 'Claude 3 Opus',     provider: 'Anthropic', speed: 'Powerful · legacy' },

  // ── OpenAI (offline fallback — prefer live fetch, see note above) ───────
  { id: 'gpt-4o',          name: 'GPT-4o',          provider: 'OpenAI', speed: 'Powerful · multimodal' },
  { id: 'gpt-4o-mini',     name: 'GPT-4o mini',     provider: 'OpenAI', speed: 'Fast · cheap' },
  { id: 'gpt-4-turbo',     name: 'GPT-4 Turbo',     provider: 'OpenAI', speed: 'Powerful · legacy' },
  { id: 'gpt-3.5-turbo',   name: 'GPT-3.5 Turbo',   provider: 'OpenAI', speed: 'Fastest · legacy' },
  { id: 'o1',              name: 'o1',              provider: 'OpenAI', speed: 'Reasoning · flagship' },
  { id: 'o1-mini',         name: 'o1-mini',         provider: 'OpenAI', speed: 'Reasoning · cheap' },
  { id: 'o1-preview',      name: 'o1-preview',      provider: 'OpenAI', speed: 'Reasoning · legacy' },
  { id: 'o3',              name: 'o3',              provider: 'OpenAI', speed: 'Reasoning · new flagship' },
  { id: 'o3-mini',         name: 'o3-mini',         provider: 'OpenAI', speed: 'Reasoning · fast' },
  { id: 'o4-mini',         name: 'o4-mini',         provider: 'OpenAI', speed: 'Reasoning · fastest' },

  // ── Google Gemini (offline fallback — prefer live fetch, see note above) ─
  // 3.7 Flash is listed explicitly rather than left to the live fetch so it is
  // offerable before any Google key exists: the selector has to be able to show
  // it in order for the user to pick it and be prompted for a key. No key ships
  // with it — GOOGLE_API_KEY/GEMINI_API_KEY is asked for on selection like any
  // other provider, and nothing here presumes one is present.
  { id: 'gemini-3.7-flash',          name: 'Gemini 3.7 Flash',   provider: 'Google', speed: 'Fast · current' },
  { id: 'gemini-2.5-pro',            name: 'Gemini 2.5 Pro',     provider: 'Google', speed: 'Powerful · long context' },
  { id: 'gemini-2.5-flash',          name: 'Gemini 2.5 Flash',   provider: 'Google', speed: 'Fast · cheap' },
  { id: 'gemini-2.0-pro',            name: 'Gemini 2.0 Pro',     provider: 'Google', speed: 'Powerful' },
  { id: 'gemini-2.0-flash',          name: 'Gemini 2.0 Flash',   provider: 'Google', speed: 'Fast' },
  { id: 'gemini-1.5-pro',            name: 'Gemini 1.5 Pro',     provider: 'Google', speed: 'Long context · legacy' },
  { id: 'gemini-1.5-flash',          name: 'Gemini 1.5 Flash',   provider: 'Google', speed: 'Fast · legacy' },
  { id: 'gemini-1.5-flash-8b',       name: 'Gemini 1.5 Flash-8B', provider: 'Google', speed: 'Fastest · tiny' },

  // ── Xiaomi MiMo ─────────────────────────────────────────────────────────
  { id: 'mimo-v2.5-pro',   name: 'MiMo V2.5 Pro',   provider: 'Xiaomi MiMo', speed: 'Powerful · 1T params' },
  { id: 'mimo-v2.5',       name: 'MiMo V2.5',       provider: 'Xiaomi MiMo', speed: 'Fast · 310B' },
  { id: 'mimo-v2-flash',   name: 'MiMo V2 Flash',   provider: 'Xiaomi MiMo', speed: 'Fastest · pay-as-you-go (sk-) keys only' },
  { id: 'mimo-v1',         name: 'MiMo V1',         provider: 'Xiaomi MiMo', speed: 'Legacy · pay-as-you-go (sk-) keys only' },

  // ── Zhipu (Z.ai GLM) — use zhipu-coding/<id> to route via the Coding Plan ─
  { id: 'glm-5.2',         name: 'GLM-5.2',         provider: 'Zhipu', speed: 'Powerful · 1M context' },
  { id: 'glm-5.1',         name: 'GLM-5.1',         provider: 'Zhipu', speed: 'Powerful · agentic' },
  { id: 'glm-5',           name: 'GLM-5',           provider: 'Zhipu', speed: 'Powerful · 744B MoE' },

  // ── BytePlus ModelArk Coding Plan (use byteplus/ prefix) ──────────────────
  { id: 'byteplus/ark-code-latest',     name: 'Ark Code (auto-select)', provider: 'BytePlus ModelArk', speed: 'Coding Plan · flagship' },
  { id: 'byteplus/dola-seed-2.0-pro',   name: 'Dola Seed 2.0 Pro',      provider: 'BytePlus ModelArk', speed: 'Coding Plan · powerful' },
  { id: 'byteplus/dola-seed-2.0-lite',  name: 'Dola Seed 2.0 Lite',     provider: 'BytePlus ModelArk', speed: 'Coding Plan · fast' },
  { id: 'byteplus/dola-seed-2.0-code',  name: 'Dola Seed 2.0 Code',     provider: 'BytePlus ModelArk', speed: 'Coding Plan · code' },
  { id: 'byteplus/bytedance-seed-code', name: 'ByteDance Seed Code',    provider: 'BytePlus ModelArk', speed: 'Coding Plan · code' },
  { id: 'byteplus/glm-5.2',             name: 'GLM-5.2 (Ark)',          provider: 'BytePlus ModelArk', speed: 'Coding Plan · 1M context' },
  { id: 'byteplus/glm-5.1',             name: 'GLM-5.1 (Ark)',          provider: 'BytePlus ModelArk', speed: 'Coding Plan · agentic' },
  { id: 'byteplus/kimi-k2.5',           name: 'Kimi K2.5 (Ark)',        provider: 'BytePlus ModelArk', speed: 'Coding Plan · reasoning' },
  { id: 'byteplus/gpt-oss-120b',        name: 'GPT-OSS 120B (Ark)',     provider: 'BytePlus ModelArk', speed: 'Coding Plan · open' },

  // ── FPT Cloud AI Marketplace (use fpt/ prefix) ────────────────────────────
  { id: 'fpt/DeepSeek-V4-Flash',         name: 'DeepSeek V4 Flash (FPT)',         provider: 'FPT Cloud AI', speed: 'Fast · MoE' },
  { id: 'fpt/GLM-5.2',                   name: 'GLM-5.2 (FPT)',                   provider: 'FPT Cloud AI', speed: 'Powerful · 1M context' },
  { id: 'fpt/Qwen3.8-27B',               name: 'Qwen3.8 27B (FPT)',               provider: 'FPT Cloud AI', speed: 'Powerful · FP8 262k' },
  { id: 'fpt/Qwen3.6-27B',               name: 'Qwen3.6 27B (FPT)',               provider: 'FPT Cloud AI', speed: 'Balanced · agentic' },
  { id: 'fpt/gemma-4-31B-it',            name: 'Gemma 4 31B (FPT)',               provider: 'FPT Cloud AI', speed: 'Powerful · 256k context' },
  { id: 'fpt/gemma-4-26B-A4B-it',        name: 'Gemma 4 26B SMoE (FPT)',          provider: 'FPT Cloud AI', speed: 'Fast · SMoE' },
  { id: 'fpt/gemma-3-27b-it',            name: 'Gemma 3 27B (FPT)',               provider: 'FPT Cloud AI', speed: 'Multimodal · 27B' },
  { id: 'fpt/gpt-oss-120b',              name: 'GPT-OSS 120B (FPT)',              provider: 'FPT Cloud AI', speed: 'Powerful · open 117B' },
  { id: 'fpt/gpt-oss-20b',               name: 'GPT-OSS 20B (FPT)',               provider: 'FPT Cloud AI', speed: 'Fast · open 21B' },
  { id: 'fpt/Llama-3.3-70B-Instruct',    name: 'Llama 3.3 70B (FPT)',             provider: 'FPT Cloud AI', speed: 'Powerful · 32k' },
  { id: 'fpt/Qwen2.5-VL-7B-Instruct',    name: 'Qwen 2.5 VL 7B (FPT)',            provider: 'FPT Cloud AI', speed: 'Vision · 7B' },
  { id: 'fpt/Vietnamese_Embedding',      name: 'Vietnamese Embedding (FPT)',      provider: 'FPT Cloud AI', speed: 'Embedding · BGE-M3' },
  { id: 'fpt/multilingual-e5-large',     name: 'Multilingual E5 Large (FPT)',     provider: 'FPT Cloud AI', speed: 'Embedding · E5' },
  { id: 'fpt/bge-reranker-v2-m3',        name: 'BGE Reranker V2 M3 (FPT)',        provider: 'FPT Cloud AI', speed: 'Reranker' },
  { id: 'fpt/FPT.AI-VITs',               name: 'FPT.AI VITs (FPT)',               provider: 'FPT Cloud AI', speed: 'TTS · Vietnamese' },
  { id: 'fpt/FPT.TTS-pro',               name: 'FPT TTS Pro (FPT)',               provider: 'FPT Cloud AI', speed: 'TTS Pro · Vietnamese' },
  { id: 'fpt/FPT.AI-whisper-large-v3-turbo', name: 'FPT Whisper Large V3 (FPT)',  provider: 'FPT Cloud AI', speed: 'STT · Vietnamese' },
  { id: 'fpt/FPT.AI-whisper-medium',     name: 'FPT Whisper Medium (FPT)',        provider: 'FPT Cloud AI', speed: 'STT · Vietnamese' },
  { id: 'fpt/whisper-large-v3-turbo',    name: 'Whisper Large V3 Turbo (FPT)',    provider: 'FPT Cloud AI', speed: 'STT · Multilingual' },

  // ── xAI Grok ────────────────────────────────────────────────────────────
  { id: 'grok-2',            name: 'Grok 2',            provider: 'xAI', speed: 'Powerful' },
  { id: 'grok-2-mini',       name: 'Grok 2 mini',       provider: 'xAI', speed: 'Fast · cheap' },
  { id: 'grok-beta',         name: 'Grok Beta',         provider: 'xAI', speed: 'Fast' },
  { id: 'grok-vision-beta',  name: 'Grok Vision Beta',  provider: 'xAI', speed: 'Multimodal' },

  // ── OpenCode Go (offline fallback — prefer live fetch, see note above) ───
  // The $10/month subscription tier at opencode.ai/zen/go/v1, reached with the
  // go-anthropic/ prefix and OPENCODE_GO_API_KEY. This is the full 25-model Go
  // lineup as of Aug 2026 — a different set from pay-as-you-go Zen, which is
  // why it needs its own list: Zen carries Claude/GPT/Gemini and the `-free`
  // tier that Go does not, and Go carries qwen3.7/3.8-max and hy3, which Zen
  // does not.
  { id: 'go-anthropic/minimax-m3',      name: 'MiniMax M3 (Go)',      provider: 'OpenCode Go', speed: 'Agentic · flagship' },
  { id: 'go-anthropic/minimax-m2.7',    name: 'MiniMax M2.7 (Go)',    provider: 'OpenCode Go', speed: 'Fast' },
  { id: 'go-anthropic/minimax-m2.5',    name: 'MiniMax M2.5 (Go)',    provider: 'OpenCode Go', speed: 'Budget' },
  { id: 'go-anthropic/kimi-k3',         name: 'Kimi K3 (Go)',         provider: 'OpenCode Go', speed: 'Reasoning · flagship' },
  { id: 'go-anthropic/kimi-k2.7-code',  name: 'Kimi K2.7 Code (Go)',  provider: 'OpenCode Go', speed: 'Code' },
  { id: 'go-anthropic/kimi-k2.6',       name: 'Kimi K2.6 (Go)',       provider: 'OpenCode Go', speed: 'Reasoning' },
  { id: 'go-anthropic/kimi-k2.5',       name: 'Kimi K2.5 (Go)',       provider: 'OpenCode Go', speed: 'Reasoning · legacy' },
  { id: 'go-anthropic/qwen3.8-max',     name: 'Qwen3.8 Max (Go)',     provider: 'OpenCode Go', speed: 'Powerful · newest' },
  { id: 'go-anthropic/qwen3.7-max',     name: 'Qwen3.7 Max (Go)',     provider: 'OpenCode Go', speed: 'Powerful' },
  { id: 'go-anthropic/qwen3.7-plus',    name: 'Qwen3.7 Plus (Go)',    provider: 'OpenCode Go', speed: 'Balanced' },
  { id: 'go-anthropic/qwen3.6-plus',    name: 'Qwen3.6 Plus (Go)',    provider: 'OpenCode Go', speed: 'Balanced · legacy' },
  { id: 'go-anthropic/qwen3.5-plus',    name: 'Qwen3.5 Plus (Go)',    provider: 'OpenCode Go', speed: 'Balanced · legacy' },
  { id: 'go-anthropic/glm-5.2',         name: 'GLM-5.2 (Go)',         provider: 'OpenCode Go', speed: 'Powerful · 1M context' },
  { id: 'go-anthropic/glm-5.1',         name: 'GLM-5.1 (Go)',         provider: 'OpenCode Go', speed: 'Powerful · agentic' },
  { id: 'go-anthropic/glm-5',           name: 'GLM-5 (Go)',           provider: 'OpenCode Go', speed: 'Powerful · 744B MoE' },
  { id: 'go-anthropic/deepseek-v4-pro', name: 'DeepSeek V4 Pro (Go)', provider: 'OpenCode Go', speed: 'Powerful' },
  { id: 'go-anthropic/deepseek-v4-flash', name: 'DeepSeek V4 Flash (Go)', provider: 'OpenCode Go', speed: 'Fast' },
  { id: 'go-anthropic/mimo-v2.5-pro',   name: 'MiMo V2.5 Pro (Go)',   provider: 'OpenCode Go', speed: 'Powerful · 1T params' },
  { id: 'go-anthropic/mimo-v2.5',       name: 'MiMo V2.5 (Go)',       provider: 'OpenCode Go', speed: 'Fast · 310B' },
  { id: 'go-anthropic/mimo-v2-pro',     name: 'MiMo V2 Pro (Go)',     provider: 'OpenCode Go', speed: 'Powerful · legacy' },
  { id: 'go-anthropic/mimo-v2-omni',    name: 'MiMo V2 Omni (Go)',    provider: 'OpenCode Go', speed: 'Multimodal' },
  { id: 'go-anthropic/hy3',             name: 'Hunyuan 3 (Go)',       provider: 'OpenCode Go', speed: 'Powerful' },
  { id: 'go-anthropic/hy3-preview',     name: 'Hunyuan 3 Preview (Go)', provider: 'OpenCode Go', speed: 'Preview' },
  { id: 'go-anthropic/gpt-5.6-luna',    name: 'GPT-5.6 Luna (Go)',    provider: 'OpenCode Go', speed: 'Powerful' },
  { id: 'go-anthropic/grok-4.5',        name: 'Grok 4.5 (Go)',        provider: 'OpenCode Go', speed: 'Powerful' },

  // ── OpenCode Zen free tier (pay-as-you-go endpoint, no credits needed) ───
  // Zen-only: the Go subscription does not serve these. Useful as a fallback
  // when an account's Zen balance has run out, since the `-free` models keep
  // answering. Zen's paid models come from live fetch.
  { id: 'zen/deepseek-v4-flash-free',  name: 'DeepSeek V4 Flash (free)',  provider: 'OpenCode Zen', speed: 'Free · fast' },
  { id: 'zen/ling-3.0-flash-free',     name: 'Ling 3.0 Flash (free)',     provider: 'OpenCode Zen', speed: 'Free · fast' },
  { id: 'zen/mimo-v2.5-free',          name: 'MiMo V2.5 (free)',          provider: 'OpenCode Zen', speed: 'Free' },
  { id: 'zen/longcat-2.0-free',        name: 'LongCat 2.0 (free)',        provider: 'OpenCode Zen', speed: 'Free' },
  { id: 'zen/nemotron-3-ultra-free',   name: 'Nemotron 3 Ultra (free)',   provider: 'OpenCode Zen', speed: 'Free · large' },
  { id: 'zen/north-mini-code-free',    name: 'North Mini Code (free)',    provider: 'OpenCode Zen', speed: 'Free · code' },
  { id: 'zen/laguna-s-2.1-free',       name: 'Laguna S 2.1 (free)',       provider: 'OpenCode Zen', speed: 'Free' },

  // ── OpenRouter (offline fallback — prefer live fetch, see note above) ────
  { id: 'openrouter/anthropic/claude-3.5-sonnet',            name: 'Claude 3.5 Sonnet (OR)',   provider: 'OpenRouter', speed: 'Fast' },
  { id: 'openrouter/anthropic/claude-3-opus',                name: 'Claude 3 Opus (OR)',       provider: 'OpenRouter', speed: 'Powerful' },
  { id: 'openrouter/openai/gpt-4o',                           name: 'GPT-4o (OR)',              provider: 'OpenRouter', speed: 'Powerful' },
  { id: 'openrouter/openai/o1',                               name: 'o1 (OR)',                  provider: 'OpenRouter', speed: 'Reasoning' },
  { id: 'openrouter/google/gemini-2.0-flash-exp',             name: 'Gemini 2.0 Flash (OR)',    provider: 'OpenRouter', speed: 'Fast' },
  { id: 'openrouter/meta-llama/llama-3.1-405b-instruct',      name: 'Llama 3.1 405B (OR)',      provider: 'OpenRouter', speed: 'Open · powerful' },
  { id: 'openrouter/meta-llama/llama-3.1-70b-instruct',       name: 'Llama 3.1 70B (OR)',       provider: 'OpenRouter', speed: 'Open · fast' },
  { id: 'openrouter/meta-llama/llama-3.1-8b-instruct',        name: 'Llama 3.1 8B (OR)',        provider: 'OpenRouter', speed: 'Open · cheap' },
  { id: 'openrouter/mistralai/mistral-large-latest',          name: 'Mistral Large (OR)',       provider: 'OpenRouter', speed: 'Powerful' },
  { id: 'openrouter/mistralai/mixtral-8x7b-instruct',         name: 'Mixtral 8x7B (OR)',        provider: 'OpenRouter', speed: 'Open · fast' },
  { id: 'openrouter/qwen/qwen-2.5-72b-instruct',              name: 'Qwen 2.5 72B (OR)',        provider: 'OpenRouter', speed: 'Open · strong' },
  { id: 'openrouter/qwen/qwen-2.5-coder-32b-instruct',        name: 'Qwen 2.5 Coder 32B (OR)',  provider: 'OpenRouter', speed: 'Open · code' },
  { id: 'openrouter/deepseek/deepseek-chat',                  name: 'DeepSeek V3 (OR)',         provider: 'OpenRouter', speed: 'Open · strong' },
  { id: 'openrouter/deepseek/deepseek-r1',                    name: 'DeepSeek R1 (OR)',         provider: 'OpenRouter', speed: 'Reasoning · open' },
  { id: 'openrouter/deepseek/deepseek-v4-pro',                name: 'DeepSeek V4 Pro (OR)',     provider: 'OpenRouter', speed: 'Powerful · open' },
  { id: 'openrouter/google/gemma-2-27b-it',                   name: 'Gemma 2 27B (OR)',         provider: 'OpenRouter', speed: 'Open · fast' },

  // ── Ollama (local) ──────────────────────────────────────────────────────
  { id: 'ollama/llama3.2',           name: 'Llama 3.2 (local)',     provider: 'Ollama', speed: 'Local · small' },
  { id: 'ollama/llama3.1',           name: 'Llama 3.1 (local)',     provider: 'Ollama', speed: 'Local · 8B-70B' },
  { id: 'ollama/llama3.3',           name: 'Llama 3.3 (local)',     provider: 'Ollama', speed: 'Local · 70B' },
  { id: 'ollama/qwen2.5',            name: 'Qwen 2.5 (local)',      provider: 'Ollama', speed: 'Local · multilingual' },
  { id: 'ollama/qwen2.5-coder',      name: 'Qwen 2.5 Coder (local)', provider: 'Ollama', speed: 'Local · code' },
  { id: 'ollama/codellama',          name: 'Code Llama (local)',   provider: 'Ollama', speed: 'Local · code' },
  { id: 'ollama/mistral',            name: 'Mistral (local)',      provider: 'Ollama', speed: 'Local · 7B' },
  { id: 'ollama/mistral-nemo',       name: 'Mistral Nemo (local)', provider: 'Ollama', speed: 'Local · 12B' },
  { id: 'ollama/mixtral',            name: 'Mixtral (local)',      provider: 'Ollama', speed: 'Local · MoE' },
  { id: 'ollama/phi3',               name: 'Phi-3 (local)',        provider: 'Ollama', speed: 'Local · tiny' },
  { id: 'ollama/gemma2',             name: 'Gemma 2 (local)',      provider: 'Ollama', speed: 'Local · Google' },
  { id: 'ollama/deepseek-coder-v2',  name: 'DeepSeek Coder V2 (local)', provider: 'Ollama', speed: 'Local · code' },
  { id: 'ollama/command-r',          name: 'Command-R (local)',    provider: 'Ollama', speed: 'Local · Cohere' },

  // ── LM Studio / local OpenAI-compatible ────────────────────────────────
  { id: 'local/qwen2.5-coder-32b-instruct',  name: 'Qwen 2.5 Coder 32B (local)', provider: 'Local', speed: 'Local · code' },
  { id: 'local/llama-3.3-70b-instruct',      name: 'Llama 3.3 70B (local)',      provider: 'Local', speed: 'Local · strong' },
  { id: 'local/mistral-large',               name: 'Mistral Large (local)',      provider: 'Local', speed: 'Local · powerful' },
];

const LIVE_PREFERRED_PROVIDERS = new Set(['Anthropic', 'OpenAI', 'Google', 'OpenRouter']);

/**
 * Get all available models — live-fetched (OpenAI/Google/OpenRouter, when
 * an API key is configured and refreshLiveModels() has run) + static
 * KNOWN_MODELS fallback + custom providers from .aura.json.
 *
 * When a live list exists for a provider, its static KNOWN_MODELS entries
 * are dropped entirely rather than merged — the static list can contain
 * retired model IDs (see the note on KNOWN_MODELS above), and a partial
 * merge would leave dead entries mixed in with real ones with no way to
 * tell them apart in the picker.
 */
export function getAllModels(): ModelCatalogEntry[] {
  const live = getLiveModels();
  const liveProviders = new Set(live.map((m) => m.provider));

  const staticFallback = KNOWN_MODELS.filter((m) => {
    if (LIVE_PREFERRED_PROVIDERS.has(m.provider) && liveProviders.has(m.provider)) {
      return false;
    }
    return true;
  });

  const all = [...staticFallback, ...live];
  for (const def of getCustomProviders()) {
    if (def.models) {
      for (const m of def.models) {
        // Avoid duplicates
        if (!all.some(x => x.id === m.id)) {
          all.push({
            id: m.id,
            name: m.name ?? m.id,
            provider: def.name,
            speed: m.speed ?? 'Custom',
          });
        }
      }
    }
  }
  return all;
}

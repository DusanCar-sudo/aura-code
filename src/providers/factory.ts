import type { LLMProvider, ProviderConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { GoogleProvider } from './google.js';
import { getApiKey, getEnv } from '../util/env.js';
import type { ProviderDef } from '../config/project-config.js';
import { getLiveModels } from './live-models.js';
import * as http from 'http';

// ─────────────────────────────────────────────────────────────────────────────
// Custom provider registry  (populated from .aura.json or programmatically)
// ─────────────────────────────────────────────────────────────────────────────

/** Zhipu (Z.ai) General/International endpoint — pay-as-you-go API keys. */
export const ZHIPU_GENERAL_BASE_URL = 'https://api.z.ai/api/paas/v4';
/** Zhipu (Z.ai) Coding Plan endpoint — GLM Coding Plan subscription quota. */
export const ZHIPU_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

let customProviders: ProviderDef[] = [];

/**
 * Register custom providers from .aura.json or any other source.
 * These are checked before built-in routing in createProvider().
 */
export function registerCustomProviders(providers: ProviderDef[]): void {
  customProviders = providers;
}

/** Get currently registered custom providers. */
export function getCustomProviders(): ProviderDef[] {
  return customProviders;
}

/**
 * Detect which provider class would handle a given model name.
 * Exported so the resilience layer can pre-build the right class.
 */
export function detectProviderKind(model: string): 'anthropic' | 'google' | 'openai-compatible' {
  const m = model.toLowerCase();
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gemini-')) return 'google';
  return 'openai-compatible';
}

/**
 * Auto-detect the right provider from the model name, then instantiate it.
 *
 * Model naming conventions:
 *   claude-*             → Anthropic
 *   gpt-*, o1-*, o3-*   → OpenAI
 *   gemini-*             → Google
 *   grok-*               → xAI (OpenAI-compatible at api.x.ai)
 *   openrouter/*         → OpenRouter (OpenAI-compatible)
 *   ollama/*             → Ollama (OpenAI-compatible at localhost:11434)
 *   local/*              → Local OpenAI-compatible (localhost:1234)
 *   anything else        → OpenAI-compatible (uses baseUrl from config)
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  const model = config.model.toLowerCase();

  // ── OpenCode Go (Anthropic-style models at /v1/messages) ───────────────
  if (model.startsWith('go-anthropic/')) {
    const goModel = model.replace('go-anthropic/', '');
    return new AnthropicProvider({
      ...config,
      model: goModel,
      baseUrl: config.baseUrl ?? 'https://opencode.ai/zen/go/v1',
      apiKey: config.apiKey ?? getApiKey('OPENCODE_GO_API_KEY'),
    }, 'OpenCode Go');
  }

  // ── Custom providers (from .aura.json) ─────────────────────────────────
  for (const def of customProviders) {
    const matched = def.prefixes.some(p => model.startsWith(p.toLowerCase()));
    if (matched) {
      const stripPrefix = def.prefixes.find(p => model.startsWith(p.toLowerCase()));
      const rawModel = stripPrefix ? model.slice(stripPrefix.length) : model;
      const apiKey = config.apiKey
        ?? (def.apiKeyEnv ? getApiKey(def.apiKeyEnv) : undefined)
        ?? (def.apiKey ?? undefined);
      return new OpenAICompatibleProvider({
        ...config,
        model: rawModel || model,
        baseUrl: config.baseUrl ?? def.baseUrl,
        apiKey,
      }, def.name);
    }
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (model.startsWith('claude-')) {
    return new AnthropicProvider(config);
  }

  // ── Google ─────────────────────────────────────────────────────────────────
  if (model.startsWith('gemini-')) {
    return new GoogleProvider(config);
  }

  // ── OpenRouter ─────────────────────────────────────────────────────────────
  if (model.startsWith('openrouter/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('openrouter/', ''),
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: config.apiKey ?? getApiKey('OPENROUTER_API_KEY'),
    }, 'OpenRouter');
  }

  // ── Xiaomi MiMo ────────────────────────────────────────────────────────────
  if (model.startsWith('mimo-') || model.startsWith('xiaomi/') || model.startsWith('mimo/')) {
    const mimoModel = model.replace(/^(xiaomi|mimo)\//, '');
    return new OpenAICompatibleProvider({
      ...config,
      model: mimoModel,
      baseUrl: config.baseUrl ?? getEnv('XIAOMI_BASE_URL') ?? 'https://token-plan-sgp.xiaomimimo.com/v1',
      apiKey: config.apiKey ?? getApiKey('XIAOMI_API_KEY'),
    }, 'Xiaomi MiMo');
  }

  // ── Zhipu (Z.ai GLM) — two endpoints ───────────────────────────────────────
  //   glm-* / zhipu/*   → General/International  https://api.z.ai/api/paas/v4
  //   zhipu-coding/*    → Coding Plan            https://api.z.ai/api/coding/paas/v4
  // ZHIPU_BASE_URL overrides either.
  if (model.startsWith('glm-') || model.startsWith('zhipu/') || model.startsWith('zhipu-coding/')) {
    const coding = model.startsWith('zhipu-coding/');
    const glmModel = model.replace(/^zhipu(-coding)?\//, '');
    return new OpenAICompatibleProvider({
      ...config,
      model: glmModel,
      baseUrl: config.baseUrl
        ?? getEnv('ZHIPU_BASE_URL')
        ?? (coding ? ZHIPU_CODING_BASE_URL : ZHIPU_GENERAL_BASE_URL),
      apiKey: config.apiKey ?? getApiKey('ZHIPU_API_KEY'),
    }, 'Zhipu');
  }

  // ── xAI / Grok ─────────────────────────────────────────────────────────────
  if (model.startsWith('grok-') || model.startsWith('xai/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('xai/', ''),
      baseUrl: 'https://api.x.ai/v1',
      apiKey: config.apiKey ?? getApiKey('XAI_API_KEY'),
    }, 'xAI');
  }

  // ── Ollama (local) ─────────────────────────────────────────────────────────
  if (model.startsWith('ollama/') || model.startsWith('ollama:')) {
    const ollamaModel = model.replace(/^ollama[/:]/, '');
    return new OpenAICompatibleProvider({
      ...config,
      model: ollamaModel,
      baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
      apiKey: 'ollama',
    }, 'Ollama');
  }

  // ── LM Studio / local OpenAI-compatible ───────────────────────────────────
  if (model.startsWith('local/') || model.startsWith('lmstudio/')) {
    const localModel = model.replace(/^(local|lmstudio)\//, '');
    return new OpenAICompatibleProvider({
      ...config,
      model: localModel,
      baseUrl: config.baseUrl ?? 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
    }, 'Local');
  }

  // ── Local profile (qwen2.5-coder:7b or similar, no API key) ─────────────
  if (model.startsWith('local-profile/')) {
    const localModel = model.replace('local-profile/', '');
    return new OpenAICompatibleProvider({
      ...config,
      model: localModel,
      baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
      apiKey: 'ollama',
    }, 'Local (Ollama)');
  }

  // ── OpenAI (default OpenAI-compatible fallback) ───────────────────────────
  return new OpenAICompatibleProvider(config);
}

/**
 * List of well-known model shortcuts for quick selection.
 * Used by `:models` in the REPL and by `--models` on the CLI.
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
export const KNOWN_MODELS: { id: string; name: string; provider: string; speed: string }[] = [
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
  { id: 'mimo-v2-flash',   name: 'MiMo V2 Flash',   provider: 'Xiaomi MiMo', speed: 'Fastest · efficient' },
  { id: 'mimo-v1',         name: 'MiMo V1',         provider: 'Xiaomi MiMo', speed: 'Legacy' },

  // ── Zhipu (Z.ai GLM) — use zhipu-coding/<id> to route via the Coding Plan ─
  { id: 'glm-5.2',         name: 'GLM-5.2',         provider: 'Zhipu', speed: 'Powerful · 1M context' },
  { id: 'glm-5.1',         name: 'GLM-5.1',         provider: 'Zhipu', speed: 'Powerful · agentic' },
  { id: 'glm-5',           name: 'GLM-5',           provider: 'Zhipu', speed: 'Powerful · 744B MoE' },

  // ── xAI Grok ────────────────────────────────────────────────────────────
  { id: 'grok-2',            name: 'Grok 2',            provider: 'xAI', speed: 'Powerful' },
  { id: 'grok-2-mini',       name: 'Grok 2 mini',       provider: 'xAI', speed: 'Fast · cheap' },
  { id: 'grok-beta',         name: 'Grok Beta',         provider: 'xAI', speed: 'Fast' },
  { id: 'grok-vision-beta',  name: 'Grok Vision Beta',  provider: 'xAI', speed: 'Multimodal' },

  // ── OpenCode Go (Anthropic-style models — use go-anthropic/ prefix) ──────
  { id: 'go-anthropic/minimax-m3',   name: 'MiniMax M3 (Go)',    provider: 'OpenCode Go', speed: 'Anthropic API · agentic' },
  { id: 'go-anthropic/minimax-m2.7', name: 'MiniMax M2.7 (Go)',  provider: 'OpenCode Go', speed: 'Anthropic API · fast' },
  { id: 'go-anthropic/minimax-m2.5', name: 'MiniMax M2.5 (Go)',  provider: 'OpenCode Go', speed: 'Anthropic API · budget' },
  { id: 'go-anthropic/qwen3.7-max',  name: 'Qwen3.7 Max (Go)',   provider: 'OpenCode Go', speed: 'Anthropic API · powerful' },
  { id: 'go-anthropic/qwen3.7-plus', name: 'Qwen3.7 Plus (Go)',  provider: 'OpenCode Go', speed: 'Anthropic API · balanced' },
  { id: 'go-anthropic/qwen3.6-plus', name: 'Qwen3.6 Plus (Go)',  provider: 'OpenCode Go', speed: 'Anthropic API · balanced' },

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
export function getAllModels(): { id: string; name: string; provider: string; speed: string }[] {
  const live = getLiveModels();
  const liveProviders = new Set(live.map((m) => m.provider));

  const staticFallback = KNOWN_MODELS.filter((m) => {
    if (LIVE_PREFERRED_PROVIDERS.has(m.provider) && liveProviders.has(m.provider)) {
      return false;
    }
    return true;
  });

  const all = [...staticFallback, ...live];
  for (const def of customProviders) {
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

/**
 * Check if Ollama is reachable at the given base URL.
 * Returns true if the server responds, false otherwise.
 */
export async function checkOllamaHealth(baseUrl: string = 'http://localhost:11434'): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(`${baseUrl}/api/tags`, { timeout: 3000 }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

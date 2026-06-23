import type { LLMProvider, ProviderConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { GoogleProvider } from './google.js';
import { getApiKey, getEnv } from '../util/env.js';
import type { ProviderDef } from '../config/project-config.js';
import * as http from 'http';
import { loadProviderConfig } from '../setup/provider-wizard.js';
import { loadGlobalConfig } from '../setup/global-config.js';
import { DEFAULTS } from '../config/defaults.js';

// ─────────────────────────────────────────────────────────────────────────────
// Custom provider registry  (populated from .aura.json or programmatically)
// ─────────────────────────────────────────────────────────────────────────────

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

/** Rough provider family for routing / alternator guardrails. */
export function modelProviderFamily(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.startsWith('deepseek/') || m.startsWith('deepseek-')) return 'deepseek';
  if (m.startsWith('mimo-') || m.startsWith('xiaomi/') || m.startsWith('mimo/')) return 'xiaomi';
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gemini-')) return 'google';
  if (m.startsWith('openrouter/')) return 'openrouter';
  if (m.startsWith('grok-') || m.startsWith('xai/')) return 'xai';
  if (m.startsWith('opencode/') || m.startsWith('zen/')) return 'opencode';
  if (m.startsWith('ollama/')) return 'ollama';
  return 'openai-compatible';
}

const FAMILY_API_KEY_ENV: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

/**
 * The name of the environment variable that holds the API key for a given
 * model's provider family (e.g. "deepseek/..." → "DEEPSEEK_API_KEY"). Returns
 * the key's *name*, not its value — used by setup wizards to tell the user
 * which variable to set. Falls back to OPENAI_API_KEY for unknown families.
 */
export function apiKeyEnvVarForModel(model: string): string {
  return FAMILY_API_KEY_ENV[modelProviderFamily(model)] ?? 'OPENAI_API_KEY';
}

/**
 * Resolves an API key for a given model, trying that model's own provider
 * family first — falling back to other configured keys only as a last
 * resort. Use this instead of an unconditional "try DeepSeek, then Xiaomi,
 * then..." chain: that ordering picks whichever key happens to exist first,
 * completely independent of which model is actually being called, which is
 * exactly how a MiMo model string ends up paired with a DeepSeek key.
 */
export function getApiKeyForModel(model: string): string | undefined {
  const family = modelProviderFamily(model);
  const preferredEnvVar = FAMILY_API_KEY_ENV[family];
  if (preferredEnvVar) {
    const preferred = getApiKey(preferredEnvVar);
    if (preferred) return preferred;
  }
  // Fall back to any other configured key, in case the user only has one
  // provider set up and is calling a model from a different family by
  // mistake — createProvider()'s own baseUrl logic will still catch and
  // correct an actual family mismatch, so this fallback can't silently
  // send the wrong key to the wrong endpoint the way the old code could.
  for (const envVar of Object.values(FAMILY_API_KEY_ENV)) {
    if (envVar === preferredEnvVar) continue;
    const key = getApiKey(envVar);
    if (key) return key;
  }
  return undefined;
}

/**
 * Known default endpoints, keyed to the same family ids `modelProviderFamily`
 * returns. Lets us recognise "this baseUrl is MiMo's, but the model is
 * DeepSeek" even when there is no saved/global config to compare against —
 * which is exactly the case on a fresh checkout (CI, first run,
 * `--reset-setup`). Without this, the cross-provider guard below only
 * activates once *some* prior config already exists to diff against.
 */
const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  'https://api.deepseek.com/v1': 'deepseek',
  'https://token-plan-sgp.xiaomimimo.com/v1': 'xiaomi',
  'https://api.anthropic.com': 'anthropic',
  'https://generativelanguage.googleapis.com/v1beta': 'google',
  'https://openrouter.ai/api/v1': 'openrouter',
  'https://api.x.ai/v1': 'xai',
};

function baseUrlFamily(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return KNOWN_PROVIDER_BASE_URLS[url];
}

/**
 * Drop baseUrl/apiKey from a different wizard setup so we never send DeepSeek to MiMo URL.
 */
export function resolveProviderTransport(
  model: string,
  opts: { baseUrl?: string; apiKey?: string },
): { baseUrl?: string; apiKey?: string } {
  const saved = loadProviderConfig();
  const globalCfg = loadGlobalConfig();
  const savedModel = saved?.model;
  const globalModel = globalCfg?.defaultModel;

  if (savedModel === model) {
    return {
      baseUrl: opts.baseUrl ?? saved?.baseUrl,
      apiKey: opts.apiKey ?? saved?.apiKey,
    };
  }
  if (
    saved?.apiKey
    && saved?.baseUrl
    && modelProviderFamily(savedModel ?? '') === 'xiaomi'
    && modelProviderFamily(model) === 'xiaomi'
  ) {
    return {
      baseUrl: opts.baseUrl ?? saved.baseUrl,
      apiKey: opts.apiKey ?? saved.apiKey,
    };
  }
  if (globalModel === model) {
    return {
      baseUrl: opts.baseUrl ?? globalCfg?.baseUrl,
      apiKey: opts.apiKey,
    };
  }

  let baseUrl = opts.baseUrl;
  if (baseUrl) {
    const tiedToOther =
      (saved?.baseUrl && baseUrl === saved.baseUrl && savedModel && savedModel !== model)
      || (globalCfg?.baseUrl && baseUrl === globalCfg.baseUrl && globalModel && globalModel !== model);

    const knownFamily = baseUrlFamily(baseUrl);
    const mismatchedKnownFamily = knownFamily !== undefined && knownFamily !== modelProviderFamily(model);

    if (tiedToOther || mismatchedKnownFamily) baseUrl = undefined;
  }

  return { baseUrl, apiKey: opts.apiKey };
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

  config = { ...config, maxTokens: config.maxTokens ?? DEFAULTS.maxTokens };

  // ── Saved provider config (from provider wizard) ────────────────────────
  // Use saved baseUrl / apiKey as fallback when not explicitly provided.
  const savedCfg = loadProviderConfig();
  if (savedCfg && !config.baseUrl) {
    const sameWizardModel = savedCfg.model === config.model;
    const sameXiaomiFamily =
      modelProviderFamily(savedCfg.model) === 'xiaomi'
      && modelProviderFamily(config.model) === 'xiaomi';
    if (sameWizardModel || sameXiaomiFamily) {
      config = { ...config, baseUrl: config.baseUrl ?? savedCfg.baseUrl };
      if (!config.apiKey && savedCfg.apiKey) {
        config = { ...config, apiKey: savedCfg.apiKey };
      }
    }
  }

  // ── Custom providers (from .aura.json) ─────────────────────────────────
  for (const def of customProviders) {
    const matched = def.prefixes.some(p => model.startsWith(p.toLowerCase()));
    if (matched) {
      // Only strip vendor/ style prefixes (e.g. deepseek/). Bare prefixes like mimo- are
      // match-only — the API model id includes the prefix (mimo-v2.5-pro).
      const stripPrefix = def.prefixes.find(
        p => p.endsWith('/') && model.startsWith(p.toLowerCase()),
      );
      const rawModel = stripPrefix ? model.slice(stripPrefix.length) : model;
      const apiKey = config.apiKey
        ?? (def.apiKey ?? undefined)
        ?? (def.apiKeyEnv ? getApiKey(def.apiKeyEnv) : undefined);
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

  // ── OpenCode Zen (OpenAI-compatible gateway) ──────────────────────────────
  if (model.startsWith('opencode/') || model.startsWith('zen/')) {
    const zenModel = model.replace(/^(opencode|zen)\//, '');
    return new OpenAICompatibleProvider({
      ...config,
      model: zenModel,
      baseUrl: config.baseUrl ?? getEnv('OPENCODE_BASE_URL') ?? 'https://opencode.ai/zen/v1',
      apiKey: config.apiKey ?? getApiKey('OPENCODE_API_KEY'),
    }, 'OpenCode Zen');
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
 */
export const KNOWN_MODELS: { id: string; name: string; provider: string; speed: string }[] = [
  // ── Anthropic Claude ─────────────────────────────────────────────────────
  { id: 'claude-opus-4-5-20251001',   name: 'Claude Opus 4.5',   provider: 'Anthropic', speed: 'Powerful · strongest' },
  { id: 'claude-sonnet-4-5-20251001', name: 'Claude Sonnet 4.5', provider: 'Anthropic', speed: 'Fast · balanced' },
  { id: 'claude-haiku-4-5-20251001',  name: 'Claude Haiku 4.5',  provider: 'Anthropic', speed: 'Fastest · cheap' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', speed: 'Fast · legacy' },
  { id: 'claude-3-5-haiku-20241022',  name: 'Claude 3.5 Haiku',  provider: 'Anthropic', speed: 'Fastest · legacy' },
  { id: 'claude-3-opus-20240229',     name: 'Claude 3 Opus',     provider: 'Anthropic', speed: 'Powerful · legacy' },

  // ── OpenAI ──────────────────────────────────────────────────────────────
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

  // ── Google Gemini ───────────────────────────────────────────────────────
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

  // ── xAI Grok ────────────────────────────────────────────────────────────
  { id: 'grok-2',            name: 'Grok 2',            provider: 'xAI', speed: 'Powerful' },
  { id: 'grok-2-mini',       name: 'Grok 2 mini',       provider: 'xAI', speed: 'Fast · cheap' },
  { id: 'grok-beta',         name: 'Grok Beta',         provider: 'xAI', speed: 'Fast' },
  { id: 'grok-vision-beta',  name: 'Grok Vision Beta',  provider: 'xAI', speed: 'Multimodal' },

  // ── OpenRouter (any model from any provider, pay-as-you-go) ──────────────
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
  { id: 'openrouter/deepseek/deepseek-v4-flash:free',   name: 'DeepSeek V4 Flash (OR)',   provider: 'OpenRouter', speed: 'Fast · 1M context · free' },
  { id: 'openrouter/deepseek/deepseek-r1',                    name: 'DeepSeek R1 (OR)',         provider: 'OpenRouter', speed: 'Reasoning · open' },
  { id: 'openrouter/deepseek/deepseek-v4-pro',                name: 'DeepSeek V4 Pro (OR)',     provider: 'OpenRouter', speed: 'Powerful · 1M context' },
  { id: 'openrouter/google/gemma-2-27b-it',                   name: 'Gemma 2 27B (OR)',         provider: 'OpenRouter', speed: 'Open · fast' },
  { id: 'openrouter/nex-agi/nex-n2-pro:free',                  name: 'Nex N2 Pro (OR)',          provider: 'OpenRouter', speed: 'Free · open' },

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

/**
 * Get all available models — built-in + custom providers from .aura.json.
 */
export function getAllModels(): { id: string; name: string; provider: string; speed: string }[] {
  const all = [...KNOWN_MODELS];
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

// ── Context window limits per model ─────────────────────────────────────────
// Published/official context window sizes (in tokens).
// Only real numbers — verified from provider documentation.
export const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude (all 200K)
  'claude-opus-4-5-20251001':   200_000,
  'claude-sonnet-4-5-20251001': 200_000,
  'claude-haiku-4-5-20251001':  200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022':  200_000,
  'claude-3-opus-20240229':     200_000,
  // OpenAI
  'gpt-4o':                     128_000,
  'gpt-4o-mini':                128_000,
  'gpt-4-turbo':                128_000,
  'gpt-3.5-turbo':               16_384,
  'o1':                         200_000,
  'o1-mini':                    128_000,
  'o1-preview':                 128_000,
  'o3':                         200_000,
  'o3-mini':                    200_000,
  'o4-mini':                    200_000,
  // Google Gemini
  'gemini-2.5-pro':           1_048_576,
  'gemini-2.5-flash':         1_048_576,
  'gemini-2.0-pro':           2_097_152,
  'gemini-2.0-flash':         1_048_576,
  'gemini-1.5-pro':           2_097_152,
  'gemini-1.5-flash':         1_048_576,
  'gemini-1.5-flash-8b':      1_048_576,
  // Xiaomi MiMo
  'mimo-v2.5-pro':            1_048_576,
  'mimo-v2.5':                1_048_576,
  'mimo-v2-flash':            1_048_576,
  'mimo-v1':                    131_072,
  // DeepSeek — also covers OpenRouter-hosted ids; getContextWindow() strips the
  // "openrouter/<vendor>/" prefix before lookup, so "openrouter/deepseek/deepseek-v4-pro"
  // resolves here. Adjust the numbers to the real published limits as needed.
  'deepseek-v4-pro':          1_048_576,
  'deepseek-v4-flash':        1_048_576,
  'deepseek-v4':              1_048_576,
  'deepseek-r1':                131_072,
  'deepseek-chat':              131_072,
  'deepseek-coder-v2':          131_072,
  // xAI Grok
  'grok-2':                     131_072,
  'grok-2-mini':                131_072,
  'grok-beta':                  131_072,
  'grok-vision-beta':           131_072,
};

/**
 * Look up the context window for a model id.
 * Returns undefined for unknown models (caller should suppress the bar).
 */
export function getContextWindow(modelId: string): number | undefined {
  // Direct match
  if (CONTEXT_WINDOWS[modelId] !== undefined) return CONTEXT_WINDOWS[modelId];
  // Strip OpenRouter prefix: "openrouter/anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet"
  const orPrefix = modelId.match(/^openrouter\/[^/]+\/(.+)$/);
  if (orPrefix) {
    const base = orPrefix[1];
    if (CONTEXT_WINDOWS[base] !== undefined) return CONTEXT_WINDOWS[base];
  }
  // Strip Ollama prefix: "ollama/llama3.2" → check without prefix
  const ollamaPrefix = modelId.replace(/^ollama\//, '');
  if (ollamaPrefix !== modelId && CONTEXT_WINDOWS[ollamaPrefix] !== undefined) {
    return CONTEXT_WINDOWS[ollamaPrefix];
  }
  return undefined;
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

function hasApiKey(...names: string[]): boolean {
  return names.some(n => !!getApiKey(n));
}

/**
 * True when this model can be called with credentials available in env / saved wizard config.
 * Used to keep competence-based model selection from routing to providers without keys.
 */
export function isModelConfigured(modelId: string): boolean {
  const model = modelId.toLowerCase();
  const savedCfg = loadProviderConfig();

  for (const def of customProviders) {
    const matched = def.prefixes.some(p => model.startsWith(p.toLowerCase()));
    if (matched) {
      if (def.apiKey?.trim()) return true;
      if (def.apiKeyEnv && hasApiKey(def.apiKeyEnv)) return true;
      return false;
    }
  }

  if (model.startsWith('claude-')) return hasApiKey('ANTHROPIC_API_KEY');
  if (model.startsWith('gemini-')) return hasApiKey('GOOGLE_API_KEY', 'GEMINI_API_KEY');
  if (model.startsWith('openrouter/')) return hasApiKey('OPENROUTER_API_KEY');
  if (model.startsWith('deepseek/')) return hasApiKey('DEEPSEEK_API_KEY');
  if (model.startsWith('xiaomi/') || model.startsWith('mimo-')) {
    return hasApiKey('XIAOMI_API_KEY')
      || !!(savedCfg?.apiKey && savedCfg.model === modelId);
  }
  if (model.startsWith('grok-') || model.includes('grok')) return hasApiKey('XAI_API_KEY');
  if (model.startsWith('ollama/')) return true;

  if (model === 'deepseek-v4-flash' || model.startsWith('deepseek-')) {
    if (hasApiKey('DEEPSEEK_API_KEY')) return true;
    if (savedCfg?.apiKey && savedCfg.model === modelId) return true;
  }

  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return hasApiKey('OPENAI_API_KEY');
  }

  if (savedCfg?.apiKey && savedCfg.model === modelId) return true;

  return false;
}

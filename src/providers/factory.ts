import type { LLMProvider, ProviderConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { GoogleProvider } from './google.js';
import { getApiKey, getEnv } from '../util/env.js';
import type { ProviderDef } from '../config/project-config.js';
import { getLiveModels } from './live-models.js';
import { PROVIDER_REGISTRY } from '../setup/provider-registry.js';
import { defaultXiaomiBaseUrl } from '../setup/xiaomi.js';
// Circular with provider-wizard (it imports the ZHIPU_* consts below) — safe
// because both sides only touch the other's exports inside function bodies.
import { loadProviderConfig } from '../setup/provider-wizard.js';
import { loadGlobalConfig } from '../setup/global-config.js';
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
 * Strip Aura's internal routing prefixes from a model id so it can be looked
 * up against registry entries (which store unprefixed ids).
 */
function stripRoutingPrefix(model: string): string {
  return model.replace(/^(opencode|zen|zhipu(-coding)?|ollama|local|lmstudio|xai|xiaomi|mimo|go-anthropic|local-profile)\//, '');
}

/**
 * Context window (in tokens) for a model, from the provider registry.
 * Returns undefined for unknown models — callers supply their own default.
 * (Reinstated: the original was lost in the backup-restore commit 6e5481a5.)
 */
export function getContextWindow(model: string): number | undefined {
  // Lazy import would be circular-safe, but provider-registry has no factory
  // dependency, so a static import is fine (see top of file).
  const candidates = [model, stripRoutingPrefix(model)];
  for (const entry of PROVIDER_REGISTRY) {
    for (const m of entry.models) {
      if (candidates.includes(m.id) && m.contextWindow > 0) return m.contextWindow;
    }
  }
  return undefined;
}

/**
 * Env var name whose value holds the API key for a given model id, matching
 * createProvider's routing rules. Custom providers (registered from
 * .aura.json) win over built-in prefixes. Returns undefined for models that
 * need no key (ollama/local) or aren't recognized.
 * (Reinstated: the original was lost in the backup-restore commit 6e5481a5.)
 */
export function apiKeyEnvVarForModel(model: string): string | undefined {
  const m = model.toLowerCase();
  for (const p of customProviders) {
    if (p.apiKeyEnv && (p.prefixes ?? []).some(pre => m.startsWith(pre.toLowerCase()))) {
      return p.apiKeyEnv;
    }
  }
  if (m.startsWith('go-anthropic/')) return 'OPENCODE_GO_API_KEY';
  if (m.startsWith('opencode/') || m.startsWith('zen/')) return 'OPENCODE_API_KEY';
  if (m.startsWith('deepseek/') || m.startsWith('deepseek-')) return 'DEEPSEEK_API_KEY';
  if (m.startsWith('glm-') || m.startsWith('zhipu')) return 'ZHIPU_API_KEY';
  if (m.startsWith('mimo-') || m.startsWith('mimo/') || m.startsWith('xiaomi/')) return 'XIAOMI_API_KEY';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'OPENAI_API_KEY';
  if (m.startsWith('claude') || m.startsWith('anthropic')) return 'ANTHROPIC_API_KEY';
  if (m.startsWith('gemini')) return 'GOOGLE_API_KEY';
  if (m.includes('grok') || m.startsWith('xai/')) return 'XAI_API_KEY';
  if (m.startsWith('openrouter/')) return 'OPENROUTER_API_KEY';
  return undefined;
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
  if (m.startsWith('glm-') || m.startsWith('zhipu/') || m.startsWith('zhipu-coding/')) return 'zhipu';
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gemini-')) return 'google';
  if (m.startsWith('openrouter/')) return 'openrouter';
  if (m.startsWith('grok-') || m.startsWith('xai/')) return 'xai';
  if (m.startsWith('opencode/') || m.startsWith('zen/') || m.startsWith('go-anthropic/')) return 'opencode';
  if (m.startsWith('ollama/')) return 'ollama';
  return 'openai-compatible';
}

const FAMILY_API_KEY_ENV: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

/**
 * Resolves an API key for a given model, trying that model's own provider
 * family first — falling back to other configured keys only as a last
 * resort. Use this instead of an unconditional "try DeepSeek, then Xiaomi,
 * then..." chain: that ordering picks whichever key happens to exist first,
 * completely independent of which model is actually being called, which is
 * exactly how a MiMo model string ends up paired with a DeepSeek key.
 * (Reinstated: the original was lost in the backup-restore commit 6e5481a5.)
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
  [ZHIPU_GENERAL_BASE_URL]: 'zhipu',
  [ZHIPU_CODING_BASE_URL]: 'zhipu',
  'https://api.anthropic.com': 'anthropic',
  'https://generativelanguage.googleapis.com/v1beta': 'google',
  'https://openrouter.ai/api/v1': 'openrouter',
  'https://api.x.ai/v1': 'xai',
  'https://opencode.ai/zen/v1': 'opencode',
};

function baseUrlFamily(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return KNOWN_PROVIDER_BASE_URLS[url];
}

/**
 * Drop baseUrl/apiKey from a different wizard setup so we never send DeepSeek to MiMo URL.
 * (Reinstated: the original was lost in the backup-restore commit 6e5481a5.)
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
 * Resolve which baseUrl (if any) should be trusted for a given task model,
 * given a project-level config and/or a global config that each carry their
 * own (model, baseUrl) pair.
 *
 * A saved config's baseUrl is only trustworthy if it was saved alongside
 * the SAME model that's actually about to be called. Without this check, a
 * project's .aura.json or the global config can hold a baseUrl from a
 * previous provider setup (e.g. DeepSeek's https://api.deepseek.com/v1)
 * that gets paired with whatever the task model resolves to NOW (e.g.
 * opencode/big-pickle, from a later env-var override) — sending an
 * OpenCode model name to DeepSeek's endpoint, which DeepSeek then rejects
 * with a 400 ("supported API model names are deepseek-v4-pro or
 * deepseek-v4-flash, but you passed big-pickle").
 *
 * Callers like telegram-bot.ts read the project fileConfig and the global
 * config independently before ever reaching createProvider() — this guard
 * covers those two sources.
 * (Reinstated: the original was lost in the backup-restore commit 6e5481a5.)
 */
export function resolveTaskModelBaseUrl(opts: {
  taskModel: string;
  envBaseUrl?: string;
  fileConfig?: { model?: string; baseUrl?: string };
  globalCfg?: { defaultModel?: string; baseUrl?: string } | null;
}): string | undefined {
  return opts.envBaseUrl
    ?? (opts.fileConfig?.model === opts.taskModel ? opts.fileConfig?.baseUrl : undefined)
    ?? (opts.globalCfg?.defaultModel === opts.taskModel ? opts.globalCfg?.baseUrl : undefined);
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

  // ── OpenCode Go (Zen endpoint — OpenAI-compatible /chat/completions) ────
  // The Zen API speaks the OpenAI wire format; routing these through the
  // Anthropic provider sent /v1/messages-shaped requests to a
  // /chat/completions endpoint.
  if (model.startsWith('go-anthropic/')) {
    const goModel = model.replace('go-anthropic/', '');
    return new OpenAICompatibleProvider({
      ...config,
      model: goModel,
      baseUrl: config.baseUrl ?? 'https://opencode.ai/zen/v1',
      apiKey: config.apiKey ?? getApiKey('OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'),
    }, 'OpenCode Go');
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
    const mimoKey = config.apiKey ?? getApiKey('XIAOMI_API_KEY');
    return new OpenAICompatibleProvider({
      ...config,
      model: mimoModel,
      // Key-type aware default: tp- keys → Token Plan endpoint, sk- keys →
      // pay-as-you-go api.xiaomimimo.com. A hardcoded token-plan URL used to
      // send pay-as-you-go keys to the wrong host.
      baseUrl: config.baseUrl ?? getEnv('XIAOMI_BASE_URL') ?? defaultXiaomiBaseUrl(mimoKey),
      apiKey: mimoKey,
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

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  // Bare `deepseek-*` (e.g. "deepseek-v4-flash") is DeepSeek's own API model
  // name, not just a routing shorthand — apiKeyEnvVarForModel and
  // isModelConfigured above already recognize it unprefixed. This branch used
  // to require the `deepseek/` slash prefix, so a caller resolving to the
  // bare name (tiered-context.ts's resolveSummaryModel) fell through every
  // branch to the OpenAI-compatible default and 401'd on a missing
  // OPENAI_API_KEY instead of reaching DeepSeek.
  if (model.startsWith('deepseek/') || model.startsWith('deepseek-')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace(/^deepseek\//, ''),
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com/v1',
      apiKey: config.apiKey ?? getApiKey('DEEPSEEK_API_KEY'),
    }, 'DeepSeek');
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
  { id: 'mimo-v2-flash',   name: 'MiMo V2 Flash',   provider: 'Xiaomi MiMo', speed: 'Fastest · pay-as-you-go (sk-) keys only' },
  { id: 'mimo-v1',         name: 'MiMo V1',         provider: 'Xiaomi MiMo', speed: 'Legacy · pay-as-you-go (sk-) keys only' },

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

function hasApiKey(...names: string[]): boolean {
  return names.some(n => !!getApiKey(n));
}

/**
 * True when this model can be called with credentials available in env / saved wizard config.
 * Used to keep competence-based model selection from routing to providers without keys.
 * (Reinstated: the original was lost in the backup-restore commit 6e5481a5.)
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
  if (model.startsWith('glm-') || model.startsWith('zhipu/') || model.startsWith('zhipu-coding/')) {
    return hasApiKey('ZHIPU_API_KEY');
  }
  if (model.startsWith('xiaomi/') || model.startsWith('mimo-') || model.startsWith('mimo/')) {
    return hasApiKey('XIAOMI_API_KEY')
      || !!(savedCfg?.apiKey && savedCfg.model === modelId);
  }
  if (model.startsWith('grok-') || model.includes('grok')) return hasApiKey('XAI_API_KEY');
  if (model.startsWith('go-anthropic/')) return hasApiKey('OPENCODE_GO_API_KEY');
  if (model.startsWith('opencode/') || model.startsWith('zen/')) return hasApiKey('OPENCODE_API_KEY');
  if (model.startsWith('ollama/') || model.startsWith('ollama:')) return true;
  if (model.startsWith('local/') || model.startsWith('lmstudio/') || model.startsWith('local-profile/')) return true;

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

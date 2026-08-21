import type { LLMProvider, ProviderConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { GoogleProvider } from './google.js';
import { getApiKey, getEnv } from '../util/env.js';
import { getCustomProviders } from './custom-registry.js';
// Value import as well as the re-export below: normalizeModelId consults the
// catalog to resolve a bare model id to its provider prefix.
import { KNOWN_MODELS } from './known-models.js';
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
/** BytePlus ModelArk Coding Plan endpoint (OpenAI wire format). The plain
 * https://ark.ap-southeast.bytepluses.com/api/v3 endpoint is pay-as-you-go
 * and does NOT consume Coding Plan quota. */
export const BYTEPLUS_CODING_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/coding/v3';
/** FPT Cloud AI Marketplace endpoint (OpenAI wire format). */
export const FPT_BASE_URL = 'https://mkp-api.fptcloud.com/v1';

// The registry itself lives in custom-registry.ts so known-models.ts can read
// it without importing this module. Re-exported for existing callers.
export { registerCustomProviders, getCustomProviders } from './custom-registry.js';

/**
 * Strip Aura's internal routing prefixes from a model id so it can be looked
 * up against registry entries (which store unprefixed ids).
 */
function stripRoutingPrefix(model: string): string {
  return model.replace(/^(opencode|zen|zhipu(-coding)?|ollama|local|lmstudio|xai|xiaomi|mimo|go-anthropic|local-profile|groq|nvidia|huggingface|kimi|qwen|gemini|minimax|stepfun|fireworks|upstage|arcee|tencent|gmi|kilocode|alibaba|byteplus|fpt|fptcloud)\//, '');
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
  for (const p of getCustomProviders()) {
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
  if (m.startsWith('groq/')) return 'GROQ_API_KEY';
  if (m.startsWith('nvidia/')) return 'NVIDIA_API_KEY';
  if (m.startsWith('huggingface/')) return 'HUGGINGFACE_API_KEY';
  if (m.startsWith('kimi/')) return 'MOONSHOT_API_KEY';
  if (m.startsWith('qwen/')) return 'DASHSCOPE_API_KEY';
  if (m.startsWith('minimax/')) return 'MINIMAX_API_KEY';
  if (m.startsWith('stepfun/')) return 'STEPFUN_API_KEY';
  if (m.startsWith('fireworks/')) return 'FIREWORKS_API_KEY';
  if (m.startsWith('upstage/')) return 'UPSTAGE_API_KEY';
  if (m.startsWith('arcee/')) return 'ARCEE_API_KEY';
  if (m.startsWith('tencent/')) return 'TENCENT_API_KEY';
  if (m.startsWith('gmi/')) return 'GMI_API_KEY';
  if (m.startsWith('kilocode/')) return 'KILOCODE_API_KEY';
  if (m.startsWith('alibaba/')) return 'ALIBABA_API_KEY';
  if (m.startsWith('byteplus/')) return 'ARK_API_KEY';
  if (m.startsWith('fpt/') || m.startsWith('fptcloud/')) return 'FPT_API_KEY';
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
  if (m.startsWith('gemini-') || m.startsWith('gemini/')) return 'google';
  if (m.startsWith('openrouter/')) return 'openrouter';
  if (m.startsWith('grok-') || m.startsWith('xai/')) return 'xai';
  if (m.startsWith('opencode/') || m.startsWith('zen/') || m.startsWith('go-anthropic/')) return 'opencode';
  if (m.startsWith('ollama/')) return 'ollama';
  if (m.startsWith('groq/')) return 'groq';
  if (m.startsWith('nvidia/')) return 'nvidia';
  if (m.startsWith('huggingface/')) return 'huggingface';
  if (m.startsWith('kimi/')) return 'kimi';
  if (m.startsWith('qwen/')) return 'qwen';
  if (m.startsWith('lmstudio/') || m.startsWith('local/')) return 'lmstudio';
  if (m.startsWith('minimax/')) return 'minimax';
  if (m.startsWith('stepfun/')) return 'stepfun';
  if (m.startsWith('fireworks/')) return 'fireworks';
  if (m.startsWith('upstage/')) return 'upstage';
  if (m.startsWith('arcee/')) return 'arcee';
  if (m.startsWith('tencent/')) return 'tencent';
  if (m.startsWith('gmi/')) return 'gmi';
  if (m.startsWith('kilocode/')) return 'kilocode';
  if (m.startsWith('alibaba/')) return 'alibaba';
  if (m.startsWith('byteplus/')) return 'byteplus';
  if (m.startsWith('fpt/') || m.startsWith('fptcloud/')) return 'fpt';
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
  groq: 'GROQ_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  upstage: 'UPSTAGE_API_KEY',
  arcee: 'ARCEE_API_KEY',
  tencent: 'TENCENT_API_KEY',
  gmi: 'GMI_API_KEY',
  kilocode: 'KILOCODE_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  byteplus: 'ARK_API_KEY',
  fpt: 'FPT_API_KEY',
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
  [BYTEPLUS_CODING_BASE_URL]: 'byteplus',
  'https://mkp-api.fptcloud.com/v1': 'fpt',
  'https://mkp-api.fptcloud.com': 'fpt',
};

/**
 * Base URL for a local model server. The model picker tells users to set
 * OLLAMA_BASE_URL / LMSTUDIO_BASE_URL and live-fetches model lists through
 * them, so completions have to honour them too — otherwise a non-default port
 * lists its models correctly in the picker and then sends every request to
 * localhost. Both the bare `host:port` and the `host:port/v1` spellings are
 * accepted, since the picker documents one and .aura.json the other.
 */
function localBaseUrl(envVar: string, fallback: string): string {
  const raw = process.env[envVar]?.trim().replace(/\/+$/, '');
  if (!raw) return fallback;
  return /\/v1$/.test(raw) ? raw : `${raw}/v1`;
}

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
    let baseUrl: string | undefined = opts.baseUrl ?? globalCfg?.baseUrl;
    if (baseUrl) {
      const knownFamily = baseUrlFamily(baseUrl);
      const mismatchedKnownFamily = knownFamily !== undefined && knownFamily !== modelProviderFamily(model);
      if (mismatchedKnownFamily) {
        baseUrl = undefined;
      }
    }
    return { baseUrl, apiKey: opts.apiKey };
  }

  let baseUrl: string | undefined = opts.baseUrl;
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

  // ── OpenCode Go (subscription endpoint — OpenAI-compatible) ─────────────
  // The Zen API speaks the OpenAI wire format; routing these through the
  // Anthropic provider sent /v1/messages-shaped requests to a
  // /chat/completions endpoint.
  //
  // `/zen/go/v1` is the Go subscription tier; `/zen/v1` is pay-as-you-go and
  // bills credits. Pointing Go at `/zen/v1` made every paid model answer
  // "401 Insufficient balance" on an account whose subscription was active and
  // whose key was fine — the request was simply being billed against the wrong
  // tier. The two tiers also serve different model lists (25 vs 61).
  if (model.startsWith('go-anthropic/')) {
    const goModel = model.replace('go-anthropic/', '');
    return new OpenAICompatibleProvider({
      ...config,
      model: goModel,
      baseUrl: config.baseUrl ?? getEnv('OPENCODE_GO_BASE_URL') ?? 'https://opencode.ai/zen/go/v1',
      apiKey: config.apiKey ?? getApiKey('OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'),
    }, 'OpenCode Go');
  }

  // ── Custom providers (from .aura.json) ─────────────────────────────────
  for (const def of getCustomProviders()) {
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
  // Accept both bare gemini-* and the selector's gemini/<id> prefixed form.
  if (model.startsWith('gemini-') || model.startsWith('gemini/')) {
    return new GoogleProvider({ ...config, model: model.replace(/^gemini\//, '') });
  }

  // ── OpenCode Zen ───────────────────────────────────────────────────────────
  // zen/* and opencode/* had key resolution (apiKeyEnvVarForModel) but no
  // routing branch — they fell through to the OpenAI-compatible default and
  // 401'd against api.openai.com.
  if (model.startsWith('zen/') || model.startsWith('opencode/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace(/^(zen|opencode)\//, ''),
      baseUrl: config.baseUrl ?? 'https://opencode.ai/zen/v1',
      apiKey: config.apiKey ?? getApiKey('OPENCODE_API_KEY'),
    }, 'OpenCode Zen');
  }

  // ── Groq ───────────────────────────────────────────────────────────────────
  if (model.startsWith('groq/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('groq/', ''),
      baseUrl: config.baseUrl ?? 'https://api.groq.com/openai/v1',
      apiKey: config.apiKey ?? getApiKey('GROQ_API_KEY'),
    }, 'Groq');
  }

  // ── NVIDIA NIM ─────────────────────────────────────────────────────────────
  if (model.startsWith('nvidia/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('nvidia/', ''),
      baseUrl: config.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
      apiKey: config.apiKey ?? getApiKey('NVIDIA_API_KEY'),
    }, 'NVIDIA NIM');
  }

  // ── Hugging Face Inference Providers ──────────────────────────────────────
  if (model.startsWith('huggingface/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('huggingface/', ''),
      baseUrl: config.baseUrl ?? 'https://router.huggingface.co/v1',
      apiKey: config.apiKey ?? getApiKey('HUGGINGFACE_API_KEY', 'HF_TOKEN'),
    }, 'Hugging Face');
  }

  // ── Kimi / Moonshot ────────────────────────────────────────────────────────
  if (model.startsWith('kimi/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('kimi/', ''),
      baseUrl: config.baseUrl ?? getEnv('MOONSHOT_BASE_URL') ?? 'https://api.moonshot.ai/v1',
      apiKey: config.apiKey ?? getApiKey('MOONSHOT_API_KEY'),
    }, 'Kimi');
  }

  // ── Qwen / DashScope ───────────────────────────────────────────────────────
  if (model.startsWith('qwen/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('qwen/', ''),
      baseUrl: config.baseUrl ?? getEnv('DASHSCOPE_BASE_URL') ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiKey: config.apiKey ?? getApiKey('DASHSCOPE_API_KEY'),
    }, 'Qwen');
  }

  // ── Simple OpenAI-compatible vendors (one table row each) ─────────────────
  // Prefix-routed like the branches above; default endpoint overridable via
  // <X>_BASE_URL. Kept in a table because they differ only in name/URL/key.
  const SIMPLE_VENDORS: Record<string, { name: string; baseUrl: string; baseUrlEnv: string; keyEnv: string }> = {
    'minimax/':   { name: 'MiniMax',        baseUrl: 'https://api.minimax.io/v1',                    baseUrlEnv: 'MINIMAX_BASE_URL',   keyEnv: 'MINIMAX_API_KEY' },
    'stepfun/':   { name: 'StepFun',        baseUrl: 'https://api.stepfun.com/v1',                   baseUrlEnv: 'STEPFUN_BASE_URL',   keyEnv: 'STEPFUN_API_KEY' },
    'fireworks/': { name: 'Fireworks AI',   baseUrl: 'https://api.fireworks.ai/inference/v1',        baseUrlEnv: 'FIREWORKS_BASE_URL', keyEnv: 'FIREWORKS_API_KEY' },
    'upstage/':   { name: 'Upstage',        baseUrl: 'https://api.upstage.ai/v1',                    baseUrlEnv: 'UPSTAGE_BASE_URL',   keyEnv: 'UPSTAGE_API_KEY' },
    'arcee/':     { name: 'Arcee AI',       baseUrl: 'https://conductor.arcee.ai/v1',                baseUrlEnv: 'ARCEE_BASE_URL',     keyEnv: 'ARCEE_API_KEY' },
    'tencent/':   { name: 'Tencent TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1',        baseUrlEnv: 'TENCENT_BASE_URL',   keyEnv: 'TENCENT_API_KEY' },
    'gmi/':       { name: 'GMI Cloud',      baseUrl: 'https://api.gmi-serving.com/v1',               baseUrlEnv: 'GMI_BASE_URL',       keyEnv: 'GMI_API_KEY' },
    'kilocode/':  { name: 'Kilo Code',      baseUrl: 'https://api.kilocode.ai/api/openrouter',       baseUrlEnv: 'KILOCODE_BASE_URL',  keyEnv: 'KILOCODE_API_KEY' },
    'alibaba/':   { name: 'Alibaba Coding', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', baseUrlEnv: 'ALIBABA_BASE_URL', keyEnv: 'ALIBABA_API_KEY' },
  };
  for (const [prefix, v] of Object.entries(SIMPLE_VENDORS)) {
    if (model.startsWith(prefix)) {
      return new OpenAICompatibleProvider({
        ...config,
        model: model.slice(prefix.length),
        baseUrl: config.baseUrl ?? getEnv(v.baseUrlEnv) ?? v.baseUrl,
        apiKey: config.apiKey ?? getApiKey(v.keyEnv),
      }, v.name);
    }
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

  // ── BytePlus ModelArk Coding Plan ─────────────────────────────────────────
  // Subscription endpoint, OpenAI-compatible wire format. Model ids are the
  // Coding Plan aliases (ark-code-latest, dola-seed-2.0-*, bytedance-seed-code,
  // ...) — see the ModelArk "Integrate with AI programming tools" docs.
  if (model.startsWith('byteplus/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: model.replace('byteplus/', ''),
      baseUrl: config.baseUrl ?? getEnv('BYTEPLUS_BASE_URL') ?? BYTEPLUS_CODING_BASE_URL,
      apiKey: config.apiKey ?? getApiKey('ARK_API_KEY'),
    }, 'BytePlus ModelArk');
  }

  // ── FPT Cloud AI (AI Marketplace) ──────────────────────────────────────────
  if (model.startsWith('fpt/') || model.startsWith('fptcloud/')) {
    return new OpenAICompatibleProvider({
      ...config,
      model: config.model.replace(/^(fpt|fptcloud)\//i, ''),
      baseUrl: config.baseUrl ?? getEnv('FPT_BASE_URL') ?? FPT_BASE_URL,
      apiKey: config.apiKey ?? getApiKey('FPT_API_KEY', 'FPTCLOUD_API_KEY'),
    }, 'FPT Cloud AI');
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
      baseUrl: config.baseUrl ?? localBaseUrl('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
      apiKey: 'ollama',
    }, 'Ollama');
  }

  // ── LM Studio / local OpenAI-compatible ───────────────────────────────────
  if (model.startsWith('local/') || model.startsWith('lmstudio/')) {
    const localModel = model.replace(/^(local|lmstudio)\//, '');
    return new OpenAICompatibleProvider({
      ...config,
      model: localModel,
      baseUrl: config.baseUrl ?? localBaseUrl('LMSTUDIO_BASE_URL', 'http://localhost:1234/v1'),
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
  // Guard the silent-misroute path. An unrecognized bare id used to be sent to
  // api.openai.com whenever an OPENAI_API_KEY happened to be set, and came back
  // as "404 The model `kimi-k3` does not exist or you do not have access to
  // it." — an OpenCode model id rejected by OpenAI, which reads like a billing
  // or account problem rather than like an id that lost its routing prefix.
  // Only OpenAI-shaped ids (or an explicit --base-url) reach OpenAI now.
  const looksOpenAI = /^(gpt-|o[134]|chatgpt|ft:|codex-|davinci|babbage|text-)/.test(model);
  if (!looksOpenAI && !config.baseUrl) {
    const candidates = prefixedCandidates(model);
    const hint = candidates.length
      ? ` Did you mean ${candidates.map(c => `"${c}"`).join(' or ')}?`
      : model.includes(':')
        ? ` Did you mean "ollama/${config.model}" (local Ollama model)?`
        : ' Use a provider-prefixed id (e.g. go-anthropic/..., deepseek/..., ollama/...) or set --base-url.';
    throw new Error(`Model "${config.model}" matches no known provider and no base URL is configured.${hint}`);
  }
  return new OpenAICompatibleProvider(config);
}

/**
 * Catalog entries whose bare (unprefixed) id is `bare` — e.g. "kimi-k2.5" →
 * ["byteplus/kimi-k2.5", "go-anthropic/kimi-k2.5"]. Only single-prefix ids
 * take part: OpenRouter's `openrouter/vendor/model` form names a vendor, not
 * a routing alias, so its trailing segment must not claim a bare id.
 */
function prefixedCandidates(bare: string): string[] {
  const needle = bare.toLowerCase();
  const out: string[] = [];
  for (const entry of KNOWN_MODELS) {
    const parts = entry.id.split('/');
    if (parts.length === 2 && parts[1].toLowerCase() === needle) out.push(entry.id);
  }
  return out;
}

/**
 * Best-effort repair for bare model ids that would otherwise fall through to
 * the OpenAI-compatible default. Ollama tags carry a `name:tag` suffix
 * (granite4.1:3b) that no cloud model id uses — those get the ollama/ prefix.
 * A bare id that exactly one catalog entry claims (minimax-m3 →
 * go-anthropic/minimax-m3) gets that entry's prefix; an id claimed by two
 * providers is left alone so createProvider can name both candidates instead
 * of guessing. Ids already recognized by modelProviderFamily pass through.
 */
export function normalizeModelId(model: string): string {
  const m = model.toLowerCase();
  // OpenCode's free tier marks its ids with a `-free` suffix that no vendor
  // uses on its own API, so the catalog outranks the family prefixes here:
  // `deepseek-v4-flash-free` starts with `deepseek-` and was being sent to
  // DeepSeek's own API, which answers "the supported API model names are
  // deepseek-v4-pro or deepseek-v4-flash".
  if (!m.includes('/') && m.endsWith('-free')) {
    const free = prefixedCandidates(m);
    if (free.length === 1) return free[0];
  }
  if (modelProviderFamily(m) !== 'openai-compatible') return model;
  if (/^(gpt-|o[134])/.test(m)) return model; // genuinely OpenAI
  if (m.includes(':') && !m.includes('/')) return `ollama/${model}`;
  if (!m.includes('/')) {
    const candidates = prefixedCandidates(m);
    if (candidates.length === 1) return candidates[0];
  }
  return model;
}

// The static model catalog and getAllModels() live in known-models.ts — the
// list churns every time a vendor ships or retires a model, and that churn
// should not touch the routing code here. Re-exported so callers that import
// them from this module keep working.
export { KNOWN_MODELS, getAllModels, type ModelCatalogEntry } from './known-models.js';

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

  for (const def of getCustomProviders()) {
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
  if (model.startsWith('byteplus/')) return hasApiKey('ARK_API_KEY');
  if (model.startsWith('fpt/') || model.startsWith('fptcloud/')) return hasApiKey('FPT_API_KEY', 'FPTCLOUD_API_KEY');
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

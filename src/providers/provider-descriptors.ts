import type { ProviderConfig } from './types.js';
import { defaultXiaomiBaseUrl } from '../setup/xiaomi.js';

// ─────────────────────────────────────────────────────────────────────────────
// The provider table — ONE entry per provider, five views derived from it.
//
// ADDING A PROVIDER IS A SINGLE-ENTRY OPERATION. Append one descriptor below
// and every routing structure follows automatically:
//
//   1. stripRoutingPrefix()      — from `prefixes` (slash-terminated ones)
//   2. apiKeyEnvVarForModel()    — from `apiKeyEnv[0]`
//   3. modelProviderFamily()     — from `family`
//   4. KNOWN_PROVIDER_BASE_URLS  — from `baseUrl` + `altBaseUrls`
//   5. createProvider()          — from `transport` + endpoint fields
//
// Before this table those five lived as five hand-maintained copies of the
// same knowledge in factory.ts, and they had silently drifted apart: deepseek/
// and openrouter/ were missing from the strip regex (costing DeepSeek 8x its
// real context window) and Hugging Face was missing from the reverse map
// (disabling the cross-provider guard for it). The consistency test in
// tests/providers/registry-consistency.test.ts is what holds the five views
// together now — it must keep passing unchanged.
//
// ORDER IS SIGNIFICANT. Matching is first-hit, top to bottom, so a provider
// that re-sells another vendor's models (opencode/grok-code, byteplus/
// deepseek-*) must appear ABOVE the vendor whose bare model names it borrows.
// ─────────────────────────────────────────────────────────────────────────────

/** Zhipu (Z.ai) General/International endpoint — pay-as-you-go API keys. */
export const ZHIPU_GENERAL_BASE_URL = 'https://api.z.ai/api/paas/v4';
/** Zhipu (Z.ai) Coding Plan endpoint — GLM Coding Plan subscription quota. */
export const ZHIPU_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
/** BytePlus ModelArk — regional; ARK_BASE_URL overrides. */
export const BYTEPLUS_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';

/** Which client class carries the traffic. Four wire formats, thirty vendors. */
export type TransportClass = 'anthropic' | 'google' | 'vertex' | 'openai-compatible';

export interface ProviderDescriptor {
  /** Stable family id — what modelProviderFamily() answers. */
  family: string;
  /** Human-facing name handed to the transport class. */
  displayName: string;
  /**
   * Routing prefixes that select this provider. Slash-terminated ones are also
   * stripped from the wire model id; `ollama:` selects and is stripped at
   * construction but is deliberately left in place by stripRoutingPrefix,
   * which has only ever handled the slash form.
   */
  prefixes: string[];
  /**
   * Bare model-id prefixes that select this provider without being stripped —
   * the vendor's own API model names (glm-5.2, deepseek-v4-pro, mimo-v2.5-pro),
   * which must reach the wire intact.
   */
  barePrefixes?: string[];
  /** API key env vars in resolution order; [0] is the canonical one. */
  apiKeyEnv?: string[];
  /** Literal key for local backends that want a placeholder, not a secret. */
  staticApiKey?: string;
  transport: TransportClass;
  /** Default endpoint. Omitted when the SDK default or a computed URL applies. */
  baseUrl?: string;
  /** Env vars overriding the endpoint, in resolution order. */
  baseUrlEnv?: string[];
  /** Host-local endpoint: normalized (a bare host gains /v1) rather than used raw. */
  localBaseUrl?: { env: string; fallback: string };
  /** Further endpoints attributed to this family in the reverse map. */
  altBaseUrls?: string[];
  /**
   * Keep this provider's endpoint out of the reverse base-URL map. Set for
   * endpoints that are computed per call, host-local, or shared with another
   * family (which the map cannot represent — it holds one owner per URL).
   */
  excludeFromReverseMap?: boolean;
  /** Endpoint that depends on the call itself (plan tier, key type). */
  resolveBaseUrl?: (config: ProviderConfig, model: string) => string;
  /** Extra provider config forced at construction. */
  extraConfig?: Partial<ProviderConfig>;
  /**
   * Route this provider ahead of the .aura.json custom providers. Only
   * OpenCode Go sets it, preserving the order createProvider has always used.
   */
  beforeCustomProviders?: boolean;
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  // ── Resellers first: they carry other vendors' bare model names ───────────
  {
    family: 'opencode', displayName: 'OpenCode Go',
    prefixes: ['go-anthropic/'],
    apiKeyEnv: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
    // The Zen entry below owns this URL in the reverse map.
    excludeFromReverseMap: true,
    beforeCustomProviders: true,
  },
  {
    family: 'opencode', displayName: 'OpenCode Zen',
    prefixes: ['opencode/', 'zen/'],
    apiKeyEnv: ['OPENCODE_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
  },

  // ── Native transports ─────────────────────────────────────────────────────
  {
    family: 'anthropic', displayName: 'Anthropic',
    prefixes: [], barePrefixes: ['claude', 'anthropic'],
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    transport: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    family: 'vertex', displayName: 'Google Vertex AI',
    prefixes: ['vertex/'],
    apiKeyEnv: ['GOOGLE_VERTEX_ACCESS_TOKEN'],
    transport: 'vertex',
    // Endpoint embeds the GCP project and region, so there is no fixed URL.
    excludeFromReverseMap: true,
    // Gemini 3.x on Vertex answers any nonzero penalty with 400 "Penalty is not
    // enabled for this model", so the repetition guard that suits DeepSeek is off.
    extraConfig: { frequencyPenalty: 0, presencePenalty: 0 },
  },
  {
    family: 'google', displayName: 'Google AI Studio',
    prefixes: ['gemini/'], barePrefixes: ['gemini-'],
    apiKeyEnv: ['GOOGLE_API_KEY'],
    transport: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  // ── OpenAI-compatible vendors ─────────────────────────────────────────────
  {
    family: 'groq', displayName: 'Groq',
    prefixes: ['groq/'], apiKeyEnv: ['GROQ_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    family: 'nvidia', displayName: 'NVIDIA NIM',
    prefixes: ['nvidia/'], apiKeyEnv: ['NVIDIA_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  {
    family: 'fpt', displayName: 'FPT Cloud AI',
    prefixes: ['fpt/'], apiKeyEnv: ['FPT_API_KEY'],
    transport: 'openai-compatible',
    // FPT_BASE_URL is honoured because the marketplace documents a per-account host.
    baseUrl: 'https://mkp-api.fptcloud.com/v1', baseUrlEnv: ['FPT_BASE_URL'],
  },
  {
    family: 'byteplus', displayName: 'BytePlus ModelArk',
    prefixes: ['byteplus/'], apiKeyEnv: ['ARK_API_KEY'],
    transport: 'openai-compatible',
    // Ark is regional (ap-southeast here), so ARK_BASE_URL is honoured.
    baseUrl: BYTEPLUS_BASE_URL, baseUrlEnv: ['ARK_BASE_URL'],
  },
  {
    family: 'huggingface', displayName: 'Hugging Face',
    prefixes: ['huggingface/'], apiKeyEnv: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
    transport: 'openai-compatible',
    baseUrl: 'https://router.huggingface.co/v1',
  },
  {
    family: 'kimi', displayName: 'Kimi',
    prefixes: ['kimi/'], apiKeyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1', baseUrlEnv: ['MOONSHOT_BASE_URL'],
  },
  {
    family: 'qwen', displayName: 'Qwen',
    prefixes: ['qwen/'], apiKeyEnv: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlEnv: ['DASHSCOPE_BASE_URL', 'QWEN_BASE_URL'],
    // The mainland endpoint is the same vendor.
    altBaseUrls: ['https://dashscope.aliyuncs.com/compatible-mode/v1'],
  },
  {
    family: 'minimax', displayName: 'MiniMax',
    prefixes: ['minimax/'], apiKeyEnv: ['MINIMAX_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.minimax.io/v1', baseUrlEnv: ['MINIMAX_BASE_URL'],
  },
  {
    family: 'stepfun', displayName: 'StepFun',
    prefixes: ['stepfun/'], apiKeyEnv: ['STEPFUN_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.stepfun.com/v1', baseUrlEnv: ['STEPFUN_BASE_URL'],
  },
  {
    family: 'fireworks', displayName: 'Fireworks AI',
    prefixes: ['fireworks/'], apiKeyEnv: ['FIREWORKS_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1', baseUrlEnv: ['FIREWORKS_BASE_URL'],
  },
  {
    family: 'upstage', displayName: 'Upstage',
    prefixes: ['upstage/'], apiKeyEnv: ['UPSTAGE_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.upstage.ai/v1', baseUrlEnv: ['UPSTAGE_BASE_URL'],
  },
  {
    family: 'arcee', displayName: 'Arcee AI',
    prefixes: ['arcee/'], apiKeyEnv: ['ARCEE_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://conductor.arcee.ai/v1', baseUrlEnv: ['ARCEE_BASE_URL'],
  },
  {
    family: 'tencent', displayName: 'Tencent TokenHub',
    prefixes: ['tencent/'], apiKeyEnv: ['TENCENT_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1', baseUrlEnv: ['TENCENT_BASE_URL'],
  },
  {
    family: 'gmi', displayName: 'GMI Cloud',
    prefixes: ['gmi/'], apiKeyEnv: ['GMI_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.gmi-serving.com/v1', baseUrlEnv: ['GMI_BASE_URL'],
  },
  {
    family: 'kilocode', displayName: 'Kilo Code',
    prefixes: ['kilocode/'], apiKeyEnv: ['KILOCODE_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.kilocode.ai/api/openrouter', baseUrlEnv: ['KILOCODE_BASE_URL'],
  },
  {
    family: 'alibaba', displayName: 'Alibaba Coding',
    prefixes: ['alibaba/'], apiKeyEnv: ['ALIBABA_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlEnv: ['ALIBABA_BASE_URL'],
    // Shares DashScope's intl endpoint with qwen/, which owns the reverse-map
    // slot. One URL cannot name two families; deferred pending a decision on
    // endpoint ownership (see registry-consistency.test.ts `sharedEndpoint`).
    excludeFromReverseMap: true,
  },
  {
    family: 'openrouter', displayName: 'OpenRouter',
    prefixes: ['openrouter/'], apiKeyEnv: ['OPENROUTER_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    family: 'xiaomi', displayName: 'Xiaomi MiMo',
    prefixes: ['xiaomi/', 'mimo/'], barePrefixes: ['mimo-'],
    apiKeyEnv: ['XIAOMI_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    baseUrlEnv: ['XIAOMI_BASE_URL'],
    // Key-type aware: tp- keys are Token Plan, sk- keys pay-as-you-go. A
    // hardcoded token-plan URL used to send pay-as-you-go keys to the wrong host.
    resolveBaseUrl: (config) => defaultXiaomiBaseUrl(config.apiKey),
  },
  {
    family: 'zhipu', displayName: 'Zhipu',
    prefixes: ['zhipu/', 'zhipu-coding/'], barePrefixes: ['glm-'],
    apiKeyEnv: ['ZHIPU_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: ZHIPU_GENERAL_BASE_URL, baseUrlEnv: ['ZHIPU_BASE_URL'],
    altBaseUrls: [ZHIPU_CODING_BASE_URL],
    // Two endpoints, one family: zhipu-coding/ draws on the Coding Plan quota,
    // everything else on the general endpoint.
    resolveBaseUrl: (_config, model) =>
      model.startsWith('zhipu-coding/') ? ZHIPU_CODING_BASE_URL : ZHIPU_GENERAL_BASE_URL,
  },
  {
    family: 'xai', displayName: 'xAI',
    prefixes: ['xai/'], barePrefixes: ['grok-'],
    apiKeyEnv: ['XAI_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
  },
  {
    family: 'deepseek', displayName: 'DeepSeek',
    prefixes: ['deepseek/'],
    // Bare `deepseek-*` is DeepSeek's own API model name, not a routing
    // shorthand, so it selects DeepSeek but reaches the wire unstripped.
    barePrefixes: ['deepseek-'],
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    transport: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1', baseUrlEnv: ['DEEPSEEK_BASE_URL'],
  },

  // ── Local backends: no vendor URL, no secret ──────────────────────────────
  {
    family: 'ollama', displayName: 'Ollama',
    prefixes: ['ollama/', 'ollama:'],
    staticApiKey: 'ollama',
    transport: 'openai-compatible',
    localBaseUrl: { env: 'OLLAMA_BASE_URL', fallback: 'http://localhost:11434/v1' },
    excludeFromReverseMap: true,
  },
  {
    family: 'lmstudio', displayName: 'Local',
    prefixes: ['local/', 'lmstudio/'],
    staticApiKey: 'lm-studio',
    transport: 'openai-compatible',
    localBaseUrl: { env: 'LMSTUDIO_BASE_URL', fallback: 'http://localhost:1234/v1' },
    excludeFromReverseMap: true,
  },
  {
    family: 'openai-compatible', displayName: 'Local (Ollama)',
    prefixes: ['local-profile/'],
    staticApiKey: 'ollama',
    transport: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    excludeFromReverseMap: true,
  },

  // ── Default: OpenAI itself, and anything unrecognized ─────────────────────
  {
    family: 'openai-compatible', displayName: 'OpenAI',
    prefixes: [], barePrefixes: ['gpt-', 'o1', 'o3', 'o4'],
    apiKeyEnv: ['OPENAI_API_KEY'],
    transport: 'openai-compatible',
    // No baseUrl: the SDK default (api.openai.com) applies.
  },
];

/** Longest matching prefix for `model`, or undefined when none matches. */
function matchedPrefix(descriptor: ProviderDescriptor, model: string): string | undefined {
  return descriptor.prefixes
    .filter(p => model.startsWith(p.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
}

/** Whether this descriptor claims `model` (lowercased) at all. */
function claims(descriptor: ProviderDescriptor, model: string): boolean {
  if (matchedPrefix(descriptor, model) !== undefined) return true;
  return (descriptor.barePrefixes ?? []).some(p => model.startsWith(p));
}

/**
 * The descriptor that owns a model id — first hit in table order, which is why
 * resellers are listed above the vendors whose model names they borrow.
 * Returns undefined for ids nothing claims (they fall through to the plain
 * OpenAI-compatible default).
 */
export function descriptorFor(modelId: string): ProviderDescriptor | undefined {
  const model = modelId.toLowerCase();
  return PROVIDER_DESCRIPTORS.find(d => claims(d, model));
}

/** The prefix that selected this model, so construction can strip exactly it. */
export function routingPrefixFor(
  descriptor: ProviderDescriptor,
  modelId: string,
): string | undefined {
  return matchedPrefix(descriptor, modelId.toLowerCase());
}

/**
 * A catalogue model id, prefixed so it routes to the provider it was listed
 * under (view 6).
 *
 * Resellers are why this exists. BytePlus and FPT serve other vendors' models
 * through their own gateway, so their catalogue entries are bare vendor names —
 * FPT lists plain "GLM-5.2". Sent unprefixed, that routes to Zhipu's own API
 * with a Zhipu key: the wrong endpoint, the wrong bill, and an "insufficient
 * balance" error naming an account the user never chose to use. Observed
 * exactly that way from the web client's provider picker.
 *
 * Matched on displayName because that is what the setup registry and the
 * /api/providers response both carry.
 *
 * The input is always a *catalogue* id from PROVIDER_REGISTRY, never something
 * a user typed, so the only thing that stops a prefix being added is the
 * provider's own prefix already being there. An earlier version also skipped
 * ids beginning with any known routing prefix, which broke Hugging Face:
 * its ids are `org/model`, and several orgs collide with routing prefixes —
 * "Qwen/Qwen2.5-Coder-32B-Instruct" looked pre-routed and went to Alibaba's
 * DashScope key instead of Hugging Face's.
 */
export function routeCatalogueId(displayName: string, modelId: string): string {
  const descriptor = PROVIDER_DESCRIPTORS.find(d => d.displayName === displayName);
  const prefix = descriptor?.prefixes.find(p => p.endsWith('/'));
  if (!prefix || modelId.startsWith(prefix)) return modelId;
  return prefix + modelId;
}

/** Every slash-terminated routing prefix, longest first (view 1). */
export function slashPrefixes(): string[] {
  return PROVIDER_DESCRIPTORS
    .flatMap(d => d.prefixes)
    .filter(p => p.endsWith('/'))
    .sort((a, b) => b.length - a.length);
}

/** The reverse base-URL map (view 4), derived from the same descriptors. */
export function buildKnownBaseUrls(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of PROVIDER_DESCRIPTORS) {
    if (d.excludeFromReverseMap) continue;
    for (const url of [d.baseUrl, ...(d.altBaseUrls ?? [])]) {
      if (url && map[url] === undefined) map[url] = d.family;
    }
  }
  return map;
}

/** Canonical API key env var per family (view 3's companion). */
export function buildFamilyApiKeyEnv(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of PROVIDER_DESCRIPTORS) {
    const canonical = d.apiKeyEnv?.[0];
    if (canonical && map[d.family] === undefined) map[d.family] = canonical;
  }
  return map;
}

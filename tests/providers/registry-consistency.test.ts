import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  stripRoutingPrefix,
  apiKeyEnvVarForModel,
  modelProviderFamily,
  KNOWN_PROVIDER_BASE_URLS,
  createProvider,
  registerCustomProviders,
  ZHIPU_GENERAL_BASE_URL,
  ZHIPU_CODING_BASE_URL,
  BYTEPLUS_BASE_URL,
} from '../../src/providers/factory.js';

// ─────────────────────────────────────────────────────────────────────────────
// Provider registry consistency
//
// factory.ts describes the same set of providers five separate times:
//
//   1. the strip regex          (stripRoutingPrefix)
//   2. the API key resolver     (apiKeyEnvVarForModel)
//   3. the provider name/family (modelProviderFamily + FAMILY_API_KEY_ENV)
//   4. the reverse base-URL map (KNOWN_PROVIDER_BASE_URLS)
//   5. the construction branch  (createProvider)
//
// Nothing forces those five to agree. A provider added to four of them and
// missed in the fifth fails at runtime, in a different way per omission:
// a missing strip entry leaves the prefix in the wire model id, a missing
// key entry sends no credential, a missing reverse-map entry defeats the
// cross-provider config guard, a missing branch falls through to the plain
// OpenAI endpoint and 401s on OPENAI_API_KEY.
//
// This test is the thing that forces agreement. It is written BEFORE the
// descriptor refactor deliberately: it must pass unchanged afterwards, which
// is the proof that collapsing the five tables into one changed no behaviour.
// ─────────────────────────────────────────────────────────────────────────────

/** One provider, as all five structures should agree it exists. */
interface RegistryExpectation {
  /** Routing prefix carried in the model id, including the trailing slash. */
  prefix: string;
  /** A representative model id using this prefix. */
  model: string;
  /** What modelProviderFamily should answer. */
  family: string;
  /** What apiKeyEnvVarForModel should answer; null when no key is needed. */
  keyEnv: string | null;
  /**
   * Default endpoint createProvider should construct, and the URL the reverse
   * map should attribute back to `family`. null for local backends, whose
   * endpoint is a host-local default rather than a known vendor URL.
   */
  baseUrl: string | null;
  /** Env var that overrides baseUrl, cleared so defaults are what we measure. */
  baseUrlEnv?: string;
  /** Set when the reverse map deliberately holds more than one URL. */
  alsoReverseMaps?: string[];
}

const REGISTRY: RegistryExpectation[] = [
  // ── Vendors with an explicit construction branch ──────────────────────────
  { prefix: 'opencode/', model: 'opencode/grok-code', family: 'opencode',
    keyEnv: 'OPENCODE_API_KEY', baseUrl: 'https://opencode.ai/zen/v1' },
  { prefix: 'zen/', model: 'zen/grok-code', family: 'opencode',
    keyEnv: 'OPENCODE_API_KEY', baseUrl: 'https://opencode.ai/zen/v1' },
  { prefix: 'go-anthropic/', model: 'go-anthropic/claude-sonnet-4', family: 'opencode',
    keyEnv: 'OPENCODE_GO_API_KEY', baseUrl: 'https://opencode.ai/zen/v1' },
  { prefix: 'groq/', model: 'groq/llama-3.3-70b', family: 'groq',
    keyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' },
  { prefix: 'nvidia/', model: 'nvidia/nemotron-4', family: 'nvidia',
    keyEnv: 'NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { prefix: 'fpt/', model: 'fpt/llama-3.1', family: 'fpt',
    keyEnv: 'FPT_API_KEY', baseUrl: 'https://mkp-api.fptcloud.com/v1',
    baseUrlEnv: 'FPT_BASE_URL' },
  { prefix: 'byteplus/', model: 'byteplus/skylark-pro', family: 'byteplus',
    keyEnv: 'ARK_API_KEY', baseUrl: BYTEPLUS_BASE_URL, baseUrlEnv: 'ARK_BASE_URL' },
  { prefix: 'huggingface/', model: 'huggingface/zephyr-7b', family: 'huggingface',
    keyEnv: 'HUGGINGFACE_API_KEY', baseUrl: 'https://router.huggingface.co/v1' },
  { prefix: 'kimi/', model: 'kimi/moonshot-v1-8k', family: 'kimi',
    keyEnv: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.ai/v1',
    baseUrlEnv: 'MOONSHOT_BASE_URL' },
  { prefix: 'qwen/', model: 'qwen/qwen-max', family: 'qwen',
    keyEnv: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlEnv: 'DASHSCOPE_BASE_URL',
    // The mainland endpoint is also attributed to qwen.
    alsoReverseMaps: ['https://dashscope.aliyuncs.com/compatible-mode/v1'] },
  { prefix: 'openrouter/', model: 'openrouter/anthropic/claude-3.5-sonnet',
    family: 'openrouter', keyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1' },
  { prefix: 'xai/', model: 'xai/grok-4', family: 'xai',
    keyEnv: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1' },
  { prefix: 'xiaomi/', model: 'xiaomi/mimo-v2.5-pro', family: 'xiaomi',
    keyEnv: 'XIAOMI_API_KEY', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    baseUrlEnv: 'XIAOMI_BASE_URL' },
  { prefix: 'mimo/', model: 'mimo/mimo-v2.5-pro', family: 'xiaomi',
    keyEnv: 'XIAOMI_API_KEY', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    baseUrlEnv: 'XIAOMI_BASE_URL' },
  { prefix: 'deepseek/', model: 'deepseek/deepseek-chat', family: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1',
    baseUrlEnv: 'DEEPSEEK_BASE_URL' },

  // Zhipu occupies two slots: one family, two endpoints. The general endpoint
  // is the default; zhipu-coding/ routes the Coding Plan. Both must resolve to
  // the same family and key, and both URLs must reverse-map to 'zhipu'.
  { prefix: 'zhipu/', model: 'zhipu/glm-5.2', family: 'zhipu',
    keyEnv: 'ZHIPU_API_KEY', baseUrl: ZHIPU_GENERAL_BASE_URL,
    baseUrlEnv: 'ZHIPU_BASE_URL' },
  { prefix: 'zhipu-coding/', model: 'zhipu-coding/glm-5.2', family: 'zhipu',
    keyEnv: 'ZHIPU_API_KEY', baseUrl: ZHIPU_CODING_BASE_URL,
    baseUrlEnv: 'ZHIPU_BASE_URL' },

  // ── Simple OpenAI-compatible vendors (the SIMPLE_VENDORS table) ───────────
  { prefix: 'minimax/', model: 'minimax/abab6.5', family: 'minimax',
    keyEnv: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1',
    baseUrlEnv: 'MINIMAX_BASE_URL' },
  { prefix: 'stepfun/', model: 'stepfun/step-2', family: 'stepfun',
    keyEnv: 'STEPFUN_API_KEY', baseUrl: 'https://api.stepfun.com/v1',
    baseUrlEnv: 'STEPFUN_BASE_URL' },
  { prefix: 'fireworks/', model: 'fireworks/llama-v3', family: 'fireworks',
    keyEnv: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1',
    baseUrlEnv: 'FIREWORKS_BASE_URL' },
  { prefix: 'upstage/', model: 'upstage/solar-pro', family: 'upstage',
    keyEnv: 'UPSTAGE_API_KEY', baseUrl: 'https://api.upstage.ai/v1',
    baseUrlEnv: 'UPSTAGE_BASE_URL' },
  { prefix: 'arcee/', model: 'arcee/virtuoso', family: 'arcee',
    keyEnv: 'ARCEE_API_KEY', baseUrl: 'https://conductor.arcee.ai/v1',
    baseUrlEnv: 'ARCEE_BASE_URL' },
  { prefix: 'tencent/', model: 'tencent/hunyuan-pro', family: 'tencent',
    keyEnv: 'TENCENT_API_KEY', baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    baseUrlEnv: 'TENCENT_BASE_URL' },
  { prefix: 'gmi/', model: 'gmi/llama-3.3', family: 'gmi',
    keyEnv: 'GMI_API_KEY', baseUrl: 'https://api.gmi-serving.com/v1',
    baseUrlEnv: 'GMI_BASE_URL' },
  { prefix: 'kilocode/', model: 'kilocode/claude-sonnet-4', family: 'kilocode',
    keyEnv: 'KILOCODE_API_KEY', baseUrl: 'https://api.kilocode.ai/api/openrouter',
    baseUrlEnv: 'KILOCODE_BASE_URL' },
  { prefix: 'alibaba/', model: 'alibaba/qwen3-coder', family: 'alibaba',
    keyEnv: 'ALIBABA_API_KEY',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlEnv: 'ALIBABA_BASE_URL' },

  // ── Local backends: no key, no vendor URL ────────────────────────────────
  { prefix: 'ollama/', model: 'ollama/qwen2.5-coder:7b', family: 'ollama',
    keyEnv: null, baseUrl: null, baseUrlEnv: 'OLLAMA_BASE_URL' },
  { prefix: 'lmstudio/', model: 'lmstudio/granite', family: 'lmstudio',
    keyEnv: null, baseUrl: null, baseUrlEnv: 'LMSTUDIO_BASE_URL' },
  { prefix: 'local/', model: 'local/granite', family: 'lmstudio',
    keyEnv: null, baseUrl: null, baseUrlEnv: 'LMSTUDIO_BASE_URL' },
  { prefix: 'local-profile/', model: 'local-profile/qwen2.5-coder:7b',
    family: 'openai-compatible', keyEnv: null, baseUrl: null },
];

/** Env vars that would override a default endpoint and mask a real mismatch. */
const OVERRIDE_ENVS = Array.from(
  new Set(REGISTRY.flatMap(r => (r.baseUrlEnv ? [r.baseUrlEnv] : []))),
).concat(['QWEN_BASE_URL']);

/** The configured endpoint, read off the underlying OpenAI SDK client. */
function baseUrlOf(provider: unknown): string | undefined {
  return (provider as { client?: { baseURL?: string } }).client?.baseURL;
}

describe('provider registry consistency across the five parallel structures', () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    registerCustomProviders([]);
    for (const key of OVERRIDE_ENVS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  describe('1. strip regex — every routing prefix is stripped from the wire id', () => {
    for (const entry of REGISTRY) {
      it(`strips ${entry.prefix}`, () => {
        const stripped = stripRoutingPrefix(entry.model);
        expect(stripped).toBe(entry.model.slice(entry.prefix.length));
      });
    }
  });

  describe('2. API key resolver — every prefix resolves to its documented key', () => {
    for (const entry of REGISTRY) {
      it(`${entry.prefix} → ${entry.keyEnv ?? 'no key'}`, () => {
        expect(apiKeyEnvVarForModel(entry.model)).toBe(entry.keyEnv ?? undefined);
      });
    }
  });

  describe('3. provider family — every prefix resolves to its family', () => {
    for (const entry of REGISTRY) {
      it(`${entry.prefix} → ${entry.family}`, () => {
        expect(modelProviderFamily(entry.model)).toBe(entry.family);
      });
    }
  });

  describe('4. reverse base-URL map — every vendor URL attributes to its family', () => {
    for (const entry of REGISTRY) {
      if (entry.baseUrl === null) continue;
      it(`${entry.baseUrl} → ${entry.family}`, () => {
        expect(KNOWN_PROVIDER_BASE_URLS[entry.baseUrl!]).toBe(entry.family);
      });
      for (const extra of entry.alsoReverseMaps ?? []) {
        it(`${extra} → ${entry.family} (secondary endpoint)`, () => {
          expect(KNOWN_PROVIDER_BASE_URLS[extra]).toBe(entry.family);
        });
      }
    }
  });

  describe('5. construction branch — every prefix builds against its endpoint', () => {
    for (const entry of REGISTRY) {
      if (entry.baseUrl === null) continue;
      it(`${entry.prefix} constructs against ${entry.baseUrl}`, () => {
        const provider = createProvider({ model: entry.model });
        expect(baseUrlOf(provider)).toBe(entry.baseUrl);
      });

      it(`${entry.prefix} sends the unprefixed model id`, () => {
        const provider = createProvider({ model: entry.model });
        expect(provider.model).toBe(entry.model.slice(entry.prefix.length));
      });
    }
  });

  describe('cross-structure agreement', () => {
    it('every reverse-mapped URL belongs to a family the resolvers know', () => {
      const knownFamilies = new Set(REGISTRY.map(r => r.family));
      const unknown = Object.entries(KNOWN_PROVIDER_BASE_URLS)
        .filter(([, family]) => !knownFamilies.has(family))
        .map(([url, family]) => `${url} → ${family}`);
      // anthropic and google are transport classes, not prefix-routed vendors,
      // so they legitimately appear here with no prefix of their own.
      expect(unknown.filter(u => !/→ (anthropic|google)$/.test(u))).toEqual([]);
    });

    it('no two families claim the same default endpoint', () => {
      const byUrl = new Map<string, string[]>();
      for (const entry of REGISTRY) {
        if (entry.baseUrl === null) continue;
        byUrl.set(entry.baseUrl, [...(byUrl.get(entry.baseUrl) ?? []), entry.family]);
      }
      const collisions = [...byUrl.entries()]
        .filter(([, families]) => new Set(families).size > 1)
        .map(([url, families]) => `${url} claimed by ${[...new Set(families)].join(', ')}`);
      expect(collisions).toEqual([]);
    });
  });
});

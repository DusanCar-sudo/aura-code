/**
 * Provider registry — all supported LLM providers with their endpoints,
 * models, env var keys, and signup URLs.
 *
 * Used by the provider wizard to let users interactively configure their
 * provider without manual env vars or --base-url flags.
 */
import { getApiKey } from '../util/env.js';
import { loadGlobalConfig } from './global-config.js';

export interface ProviderModel {
  id: string;
  label: string;
  speed: string;
  contextWindow: number;
}

export interface ProviderEntry {
  name: string;
  baseUrl: string;
  envKey: string | null;
  signupUrl: string;
  models: ProviderModel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_REGISTRY: ProviderEntry[] = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', speed: 'Fast', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', speed: 'Powerful', contextWindow: 1_000_000 },
    ],
  },
  {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-5-20251001', label: 'Claude Sonnet 4.5', speed: 'Fast', contextWindow: 200_000 },
      { id: 'claude-opus-4-5-20251001', label: 'Claude Opus 4.5', speed: 'Powerful', contextWindow: 200_000 },
    ],
  },
  {
    name: 'OpenAI (GPT)',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', speed: 'Fast', contextWindow: 128_000 },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', speed: 'Fast', contextWindow: 128_000 },
      { id: 'o1', label: 'o1', speed: 'Reasoning', contextWindow: 200_000 },
    ],
  },
  {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GOOGLE_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', speed: 'Fast', contextWindow: 1_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', speed: 'Powerful', contextWindow: 1_000_000 },
    ],
  },
  {
    name: 'Xiaomi MiMo',
    envKey: 'XIAOMI_API_KEY',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    signupUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    models: [
      { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', speed: 'Powerful · Token Plan', contextWindow: 1_048_576 },
      { id: 'mimo-v2.5', label: 'MiMo V2.5', speed: 'Fast · Token Plan', contextWindow: 1_048_576 },
    ],
  },
  {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'auto', label: 'Auto (best available)', speed: 'Auto', contextWindow: 128_000 },
    ],
  },
  {
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    models: [
      { id: 'grok-2', label: 'Grok 2', speed: 'Powerful', contextWindow: 131_072 },
    ],
  },
  {
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    envKey: 'OPENCODE_API_KEY',
    signupUrl: 'https://opencode.ai',
    models: [
      { id: 'opencode/gpt-5-nano', label: 'GPT-5 Nano (free)', speed: 'Fast · free', contextWindow: 128_000 },
      { id: 'opencode/big-pickle', label: 'Big Pickle (free)', speed: 'Powerful · free', contextWindow: 128_000 },
      { id: 'opencode/mimo-v2.5-free', label: 'MiMo V2.5 (free)', speed: 'Fast · free', contextWindow: 128_000 },
      { id: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5 (free)', speed: 'Reasoning · free', contextWindow: 128_000 },
      { id: 'opencode/nemotron-3-super-free', label: 'Nemotron 3 Super (free)', speed: 'Fast · free', contextWindow: 128_000 },
      { id: 'opencode/ling-2.6-flash-free', label: 'Ling 2.6 Flash (free)', speed: 'Fast · free', contextWindow: 128_000 },
    ],
  },
  {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    signupUrl: 'https://build.nvidia.com',
    models: [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B', speed: 'Powerful', contextWindow: 131_072 },
    ],
  },
  {
    name: 'GLM (Zhipu)',
    // General endpoint as default; the wizard swaps in the Coding Plan
    // endpoint when the user picks that plan.
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    signupUrl: 'https://z.ai',
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2', speed: 'Powerful · 1M context', contextWindow: 1_000_000 },
      { id: 'glm-5.1', label: 'GLM-5.1', speed: 'Powerful · agentic', contextWindow: 200_000 },
      { id: 'glm-5',   label: 'GLM-5',   speed: 'Powerful · 744B MoE', contextWindow: 200_000 },
    ],
  },
  {
    name: 'BytePlus ModelArk',
    // Coding Plan subscription endpoint (OpenAI-compatible wire format).
    // The plain https://ark.ap-southeast.bytepluses.com/api/v3 endpoint is
    // pay-as-you-go and does NOT consume Coding Plan quota.
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    envKey: 'ARK_API_KEY',
    signupUrl: 'https://www.byteplus.com/en/activity/codingplan',
    models: [
      { id: 'ark-code-latest',     label: 'Ark Code (auto-select)', speed: 'Coding Plan · flagship', contextWindow: 200_000 },
      { id: 'dola-seed-2.0-pro',   label: 'Dola Seed 2.0 Pro',      speed: 'Coding Plan · powerful', contextWindow: 200_000 },
      { id: 'dola-seed-2.0-lite',  label: 'Dola Seed 2.0 Lite',     speed: 'Coding Plan · fast', contextWindow: 200_000 },
      { id: 'dola-seed-2.0-code',  label: 'Dola Seed 2.0 Code',     speed: 'Coding Plan · code', contextWindow: 200_000 },
      { id: 'bytedance-seed-code', label: 'ByteDance Seed Code',    speed: 'Coding Plan · code', contextWindow: 200_000 },
      { id: 'glm-5.2',             label: 'GLM-5.2 (Ark)',          speed: 'Coding Plan · 1M context', contextWindow: 1_000_000 },
      { id: 'glm-5.1',             label: 'GLM-5.1 (Ark)',          speed: 'Coding Plan · agentic', contextWindow: 200_000 },
      { id: 'kimi-k2.5',           label: 'Kimi K2.5 (Ark)',        speed: 'Coding Plan · reasoning', contextWindow: 200_000 },
      { id: 'gpt-oss-120b',        label: 'GPT-OSS 120B (Ark)',     speed: 'Coding Plan · open', contextWindow: 200_000 },
    ],
  },
  {
    name: 'FPT Cloud AI',
    baseUrl: 'https://mkp-api.fptcloud.com/v1',
    envKey: 'FPT_API_KEY',
    signupUrl: 'https://marketplace.fptcloud.com/en/my-account#my-api-key',
    models: [
      { id: 'DeepSeek-V4-Flash',         label: 'DeepSeek V4 Flash',         speed: 'Fast · MoE', contextWindow: 500_000 },
      { id: 'GLM-5.2',                   label: 'GLM-5.2',                   speed: 'Powerful · 1M context', contextWindow: 1_000_000 },
      { id: 'Qwen3.8-27B',               label: 'Qwen3.8 27B',               speed: 'Powerful · FP8 262k', contextWindow: 262_144 },
      { id: 'Qwen3.6-27B',               label: 'Qwen3.6 27B',               speed: 'Balanced · agentic', contextWindow: 262_000 },
      { id: 'gemma-4-31B-it',            label: 'Gemma 4 31B',               speed: 'Powerful · 256k context', contextWindow: 262_000 },
      { id: 'gemma-4-26B-A4B-it',        label: 'Gemma 4 26B SMoE',          speed: 'Fast · SMoE', contextWindow: 262_000 },
      { id: 'gemma-3-27b-it',            label: 'Gemma 3 27B',               speed: 'Multimodal · 27B', contextWindow: 128_000 },
      { id: 'gpt-oss-120b',              label: 'GPT-OSS 120B',              speed: 'Powerful · open 117B', contextWindow: 200_000 },
      { id: 'gpt-oss-20b',               label: 'GPT-OSS 20B',               speed: 'Fast · open 21B', contextWindow: 128_000 },
      { id: 'Llama-3.3-70B-Instruct',    label: 'Llama 3.3 70B',             speed: 'Powerful · 32k', contextWindow: 32_000 },
      { id: 'Qwen2.5-VL-7B-Instruct',    label: 'Qwen 2.5 VL 7B',            speed: 'Vision · 7B', contextWindow: 33_000 },
      { id: 'Vietnamese_Embedding',      label: 'Vietnamese Embedding',      speed: 'Embedding · BGE-M3', contextWindow: 8_000 },
      { id: 'multilingual-e5-large',     label: 'Multilingual E5 Large',     speed: 'Embedding · E5', contextWindow: 8_000 },
      { id: 'bge-reranker-v2-m3',        label: 'BGE Reranker V2 M3',        speed: 'Reranker', contextWindow: 8_000 },
      { id: 'FPT.AI-VITs',               label: 'FPT.AI VITs',               speed: 'TTS · Vietnamese', contextWindow: 10_000 },
      { id: 'FPT.TTS-pro',               label: 'FPT TTS Pro',               speed: 'TTS Pro · Vietnamese', contextWindow: 10_000 },
      { id: 'FPT.AI-whisper-large-v3-turbo', label: 'FPT Whisper Large V3',  speed: 'STT · Vietnamese', contextWindow: 16_000 },
      { id: 'FPT.AI-whisper-medium',     label: 'FPT Whisper Medium',        speed: 'STT · Vietnamese', contextWindow: 16_000 },
      { id: 'whisper-large-v3-turbo',    label: 'Whisper Large V3 Turbo',    speed: 'STT · Multilingual', contextWindow: 16_000 },
    ],
  },
  {
    name: 'Ollama (local, free)',
    baseUrl: 'http://localhost:11434/v1',
    envKey: null, // No API key needed
    signupUrl: 'https://ollama.com',
    models: [], // Auto-detect from running Ollama instance
  },
  {
    name: 'Custom endpoint',
    baseUrl: '', // User provides
    envKey: null,
    signupUrl: '',
    models: [], // User provides model ID
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a provider entry by display name (case-insensitive).
 */
export function findProviderByName(name: string): ProviderEntry | undefined {
  return PROVIDER_REGISTRY.find(p => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Detect an existing API key for a provider.
 * Checks process.env first, then the global config file.
 */
export function detectExistingKey(provider: ProviderEntry): string | null {
  if (!provider.envKey) return null;

  // 1. Check process.env (canonical + lowercase)
  const envVal = getApiKey(provider.envKey);
  if (envVal) return envVal;

  // 2. Check saved config
  const cfg = loadGlobalConfig();
  if (cfg && cfg.apiKeyEnv === provider.envKey) {
    // The global config stores the env var name, not the key itself.
    // But the provider wizard saves the key to config.json as well.
    // Check if there's a saved key via any saved config mechanism.
    return null;
  }

  return null;
}

/**
 * Get the signup URL for a provider (for display when the user needs a key).
 */
export function getSignupUrl(provider: ProviderEntry): string {
  return provider.signupUrl;
}

/**
 * Mask an API key for safe display — show first 4 + last 4 characters.
 * Keys shorter than 10 chars just show '****'.
 */
export function maskApiKey(key: string): string {
  if (key.length < 10) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

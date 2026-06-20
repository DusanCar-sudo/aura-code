/**
 * Provider registry — all supported LLM providers with their endpoints,
 * models, env var keys, and signup URLs.
 *
 * Used by the provider wizard to let users interactively configure their
 * provider without manual env vars or --base-url flags.
 */
import { getApiKey } from '../util/env.js';
import { loadGlobalConfig } from './global-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderModel {
  id: string;           // Model ID to pass to the API
  label: string;        // Display name
  speed: string;        // "Fast" | "Powerful" | "Reasoning" | "Legacy"
  contextWindow: number; // Token limit
}

export interface ProviderEntry {
  name: string;           // Display name
  baseUrl: string;        // API endpoint (auto-set, user never sees this)
  envKey: string | null;  // Environment variable name to check for existing key
  signupUrl: string;      // Where to get an API key
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
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', speed: 'Fast', contextWindow: 1000000 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', speed: 'Powerful', contextWindow: 1000000 },
    ],
  },
  {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-5-20251001', label: 'Claude Sonnet 4.5', speed: 'Fast', contextWindow: 200000 },
      { id: 'claude-opus-4-5-20251001', label: 'Claude Opus 4.5', speed: 'Powerful', contextWindow: 200000 },
    ],
  },
  {
    name: 'OpenAI (GPT)',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', speed: 'Fast', contextWindow: 128000 },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', speed: 'Fast', contextWindow: 128000 },
      { id: 'o1', label: 'o1', speed: 'Reasoning', contextWindow: 200000 },
    ],
  },
  {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GOOGLE_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', speed: 'Fast', contextWindow: 1000000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', speed: 'Powerful', contextWindow: 1000000 },
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
      { id: 'auto', label: 'Auto (best available)', speed: 'Auto', contextWindow: 128000 },
    ],
  },
  {
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    models: [
      { id: 'grok-2', label: 'Grok 2', speed: 'Powerful', contextWindow: 131072 },
    ],
  },
  {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    signupUrl: 'https://build.nvidia.com',
    models: [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B', speed: 'Powerful', contextWindow: 131072 },
    ],
  },
  {
    name: 'Ollama (local, free)',
    baseUrl: 'http://localhost:11434/v1',
    envKey: null,  // No API key needed
    signupUrl: 'https://ollama.com',
    models: [],    // Auto-detect from running Ollama instance
  },
  {
    name: 'Custom endpoint',
    baseUrl: '',   // User provides
    envKey: null,
    signupUrl: '',
    models: [],    // User provides model ID
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a provider entry by display name (case-insensitive).
 */
export function findProviderByName(name: string): ProviderEntry | undefined {
  return PROVIDER_REGISTRY.find(
    p => p.name.toLowerCase() === name.toLowerCase(),
  );
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

import { getApiKey } from '../util/env.js';

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  speed: string;
}

let liveModelsCache: ModelEntry[] = [];

/**
 * Synchronous accessor for whatever refreshLiveModels() last fetched.
 * Empty array until the first refresh completes — getAllModels() in
 * factory.ts falls back to the static KNOWN_MODELS list in that case.
 */
export function getLiveModels(): ModelEntry[] {
  return liveModelsCache;
}

const FETCH_TIMEOUT_MS = 8_000;

async function fetchAnthropicModels(): Promise<ModelEntry[]> {
  const apiKey = getApiKey('ANTHROPIC_API_KEY');
  if (!apiKey) return [];
  try {
    const results: ModelEntry[] = [];
    let afterId: string | undefined;

    // Anthropic's /v1/models is paginated (has_more / last_id) — loop
    // until exhausted so a growing model catalog doesn't silently get
    // truncated to just the first page.
    for (let page = 0; page < 10; page++) {
      const url = new URL('https://api.anthropic.com/v1/models');
      if (afterId) url.searchParams.set('after_id', afterId);

      const resp = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return page === 0 ? [] : results;

      const data = (await resp.json()) as {
        data: { id: string; display_name?: string; type: string }[];
        has_more: boolean;
        last_id: string | null;
      };

      for (const m of data.data) {
        if (m.type !== 'model') continue;
        results.push({ id: m.id, name: m.display_name ?? m.id, provider: 'Anthropic', speed: 'Live' });
      }

      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }

    return results;
  } catch {
    return [];
  }
}

// OpenAI's /v1/models returns every model type it hosts — embeddings, TTS,
// Whisper, DALL-E/image, moderation, realtime, legacy completions. Only
// chat-capable text models belong in the picker.
const OPENAI_EXCLUDE = /embedding|whisper|tts|dall-e|gpt-image|davinci|babbage|ada-|curie|moderation|realtime|audio|transcribe|computer-use/i;

async function fetchOpenAIModels(): Promise<ModelEntry[]> {
  const apiKey = getApiKey('OPENAI_API_KEY');
  if (!apiKey) return [];
  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { data: { id: string }[] };
    return data.data
      .filter((m) => !OPENAI_EXCLUDE.test(m.id))
      .map((m) => ({ id: m.id, name: m.id, provider: 'OpenAI', speed: 'Live' }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchGoogleModels(): Promise<ModelEntry[]> {
  const apiKey = getApiKey('GOOGLE_API_KEY');
  if (!apiKey) return [];
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      models: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
    };
    return data.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => {
        const id = m.name.replace(/^models\//, '');
        return { id, name: m.displayName ?? id, provider: 'Google', speed: 'Live' };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchOpenRouterModels(limit: number): Promise<ModelEntry[]> {
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      data: { id: string; name?: string; context_length?: number }[];
    };
    // OpenRouter lists 300+ models — cap to the top N by context length as
    // a simple, defensible ranking (no popularity/quality signal available
    // from this endpoint without additional calls).
    return data.data
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
      .slice(0, limit)
      .map((m) => ({
        id: `openrouter/${m.id}`,
        name: `${m.name ?? m.id} (OR)`,
        provider: 'OpenRouter',
        speed: 'Live',
      }));
  } catch {
    return [];
  }
}

/**
 * Fetch live model lists from every provider with a configured API key,
 * merge into the module cache. Best-effort: a provider with no key, a
 * network failure, or a non-200 response contributes nothing for that
 * provider — getAllModels() falls back to static entries in that case.
 * Never throws.
 *
 * Call once at startup (fire-and-forget, see index.ts). Safe to call
 * again later to refresh (e.g. a future refresh REPL command).
 */
export async function refreshLiveModels(openRouterLimit = 8): Promise<void> {
  const [anthropic, openai, google, openrouter] = await Promise.all([
    fetchAnthropicModels(),
    fetchOpenAIModels(),
    fetchGoogleModels(),
    fetchOpenRouterModels(openRouterLimit),
  ]);
  liveModelsCache = [...anthropic, ...openai, ...google, ...openrouter];
}

// ─── Per-provider live fetching for the two-level :provider selector ────────

export interface LiveModel {
  id: string;        // full prefixed id, e.g. "openrouter/openai/gpt-4o"
  name?: string;     // display name if available
  free?: boolean;    // true if the model is free to use
}

/**
 * Providers whose /models endpoint speaks the OpenAI wire format
 * (GET {base}/models → { data: [{ id }] }). One generic fetch covers all.
 * `prefix` is the routing prefix createProvider expects; empty string for
 * families the factory pattern-matches on the bare id (gpt-*, glm-*, …).
 */
const OPENAI_COMPAT_MODELS: Record<string, { base: string; envKey: string; prefix: string; exclude?: RegExp }> = {
  deepseek:       { base: 'https://api.deepseek.com/v1',    envKey: 'DEEPSEEK_API_KEY', prefix: 'deepseek/' },
  openai:         { base: 'https://api.openai.com/v1',      envKey: 'OPENAI_API_KEY',   prefix: '', exclude: OPENAI_EXCLUDE },
  glm:            { base: 'https://api.z.ai/api/paas/v4',   envKey: 'ZHIPU_API_KEY',    prefix: '' },
  'opencode-zen': { base: 'https://opencode.ai/zen/v1',     envKey: 'OPENCODE_API_KEY', prefix: 'zen/' },
  fireworks:      { base: 'https://api.fireworks.ai/inference/v1', envKey: 'FIREWORKS_API_KEY', prefix: 'fireworks/' },
};

async function fetchOpenAICompatModels(cfg: { base: string; envKey: string; prefix: string; exclude?: RegExp }): Promise<LiveModel[]> {
  const key = getApiKey(cfg.envKey);
  if (!key) return [];
  const base = process.env[cfg.envKey.replace(/_API_KEY$/, '_BASE_URL')] ?? cfg.base;
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) return [];
  const d = await r.json() as { data?: { id: string }[] };
  return (d.data ?? [])
    .filter(m => !cfg.exclude || !cfg.exclude.test(m.id))
    .map(m => ({ id: `${cfg.prefix}${m.id}`, name: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Fetch the live model list for one provider (used by the :provider / :model
 * selectors). Falls back to empty array on any error — the caller uses the
 * static list instead. Never throws.
 */
export async function fetchLiveModels(providerId: string): Promise<LiveModel[]> {
  try {
    const compat = OPENAI_COMPAT_MODELS[providerId];
    if (compat) return await fetchOpenAICompatModels(compat);

    switch (providerId) {

      case 'anthropic': {
        // Bare claude-* ids route natively — no prefix needed.
        return (await fetchAnthropicModels()).map(m => ({ id: m.id, name: m.name }));
      }

      case 'mimo': {
        // Endpoint depends on key type: tp- keys → Token Plan host,
        // sk- keys → pay-as-you-go host (mirrors factory routing).
        const key = getApiKey('XIAOMI_API_KEY');
        if (!key) return [];
        const base = process.env.XIAOMI_BASE_URL
          ?? (key.startsWith('tp-')
            ? 'https://token-plan-sgp.xiaomimimo.com/v1'
            : 'https://api.xiaomimimo.com/v1');
        return await fetchOpenAICompatModels({ base, envKey: 'XIAOMI_API_KEY', prefix: '' });
      }

      case 'ollama': {
        const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) return [];
        const d = await r.json() as { models?: { name: string }[] };
        return (d.models ?? []).map(m => ({ id: `ollama/${m.name}`, name: m.name }));
      }

      case 'lmstudio': {
        const base = process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234';
        const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) return [];
        const d = await r.json() as { data?: { id: string }[] };
        return (d.data ?? []).map(m => ({ id: `lmstudio/${m.id}`, name: m.id }));
      }

      case 'openrouter': {
        const key = getApiKey('OPENROUTER_API_KEY');
        if (!key) return [];
        const r = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!r.ok) return [];
        const d = await r.json() as {
          data?: { id: string; name?: string; pricing?: { prompt: string } }[]
        };
        return (d.data ?? []).map(m => ({
          id: `openrouter/${m.id}`,
          name: m.name ?? m.id,
          free: m.pricing?.prompt === '0',
        }));
      }

      case 'groq': {
        const key = getApiKey('GROQ_API_KEY');
        if (!key) return [];
        const r = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!r.ok) return [];
        const d = await r.json() as { data?: { id: string }[] };
        return (d.data ?? []).map(m => ({ id: `groq/${m.id}`, name: m.id }));
      }

      case 'nvidia': {
        const key = getApiKey('NVIDIA_API_KEY');
        if (!key) return [];
        const r = await fetch('https://integrate.api.nvidia.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!r.ok) return [];
        const d = await r.json() as { data?: { id: string }[] };
        return (d.data ?? []).map(m => ({ id: `nvidia/${m.id}`, name: m.id }));
      }

      case 'gemini': {
        const key = getApiKey('GOOGLE_API_KEY');
        if (!key) return [];
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
          { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        );
        if (!r.ok) return [];
        const d = await r.json() as { models?: { name: string; displayName?: string }[] };
        return (d.models ?? []).map(m => ({
          id: `gemini/${m.name.replace('models/', '')}`,
          name: m.displayName ?? m.name,
        }));
      }

      case 'huggingface': {
        const key = getApiKey('HUGGINGFACE_API_KEY');
        if (!key) return [];
        const r = await fetch('https://huggingface.co/api/inference-endpoints', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!r.ok) return [];
        const d = await r.json() as { id?: string }[];
        return (Array.isArray(d) ? d : []).map(m => ({
          id: `huggingface/${m.id ?? ''}`,
          name: m.id,
        }));
      }

      default:
        return [];
    }
  } catch {
    return [];
  }
}

export interface ProviderEntry {
  id: string;
  name: string;
  desc: string;
  envKey?: string;       // env var that proves it's configured
  liveFetch?: boolean;   // true = call fetchLiveModels(id)
}

export const PROVIDER_LIST: ProviderEntry[] = [
  { id: 'deepseek',     name: 'DeepSeek',                  desc: 'V3, R1, coder — direct API',                    envKey: 'DEEPSEEK_API_KEY',    liveFetch: true },
  { id: 'openrouter',   name: 'OpenRouter',                desc: 'Pay-per-use aggregator, free models available',  envKey: 'OPENROUTER_API_KEY',  liveFetch: true },
  { id: 'ollama',       name: 'Ollama (local)',             desc: 'Local models on your GPU — free',               liveFetch: true },
  { id: 'gemini',       name: 'Google AI Studio',          desc: 'Native Gemini API',                             envKey: 'GOOGLE_API_KEY',      liveFetch: true },
  { id: 'glm',          name: 'Z.AI / GLM',                desc: 'Zhipu direct API',                              envKey: 'ZHIPU_API_KEY',       liveFetch: true },
  { id: 'mimo',         name: 'Xiaomi MiMo',               desc: 'MiMo-V2.5 and V2 models',                      envKey: 'XIAOMI_API_KEY',      liveFetch: true },
  { id: 'groq',         name: 'Groq',                      desc: 'Very fast inference',                           envKey: 'GROQ_API_KEY',        liveFetch: true },
  { id: 'nvidia',       name: 'NVIDIA NIM',                desc: 'Nemotron models via build.nvidia.com',          envKey: 'NVIDIA_API_KEY',      liveFetch: true },
  { id: 'anthropic',    name: 'Anthropic',                 desc: 'Claude models via API key',                     envKey: 'ANTHROPIC_API_KEY',   liveFetch: true },
  { id: 'openai',       name: 'OpenAI',                    desc: 'GPT models direct API',                         envKey: 'OPENAI_API_KEY',      liveFetch: true },
  { id: 'opencode-zen', name: 'OpenCode Zen',              desc: 'Pay-as-you-go endpoint',                        envKey: 'OPENCODE_API_KEY',    liveFetch: true },
  { id: 'opencode-go',  name: 'OpenCode Go',               desc: '$10/month subscription',                        envKey: 'OPENCODE_GO_API_KEY' },
  { id: 'lmstudio',     name: 'LM Studio',                 desc: 'Local desktop app with built-in model server',  liveFetch: true },
  { id: 'huggingface',  name: 'Hugging Face',              desc: 'Inference Providers',                           envKey: 'HUGGINGFACE_API_KEY', liveFetch: true },
  { id: 'vertex',       name: 'Google Vertex AI',          desc: 'Gemini via GCP; OAuth2 or ADC',                 envKey: 'GOOGLE_API_KEY' },
  { id: 'kimi',         name: 'Kimi / Moonshot',           desc: 'Coding Plan, global & China endpoints',         envKey: 'MOONSHOT_API_KEY' },
  { id: 'minimax',      name: 'MiniMax',                   desc: 'Global, OAuth Coding Plan & China',             envKey: 'MINIMAX_API_KEY' },
  { id: 'qwen',         name: 'Qwen Cloud / DashScope',    desc: 'Qwen + multi-provider',                         envKey: 'DASHSCOPE_API_KEY' },
  { id: 'stepfun',      name: 'StepFun Step Plan',         desc: 'Agent / coding models',                         envKey: 'STEPFUN_API_KEY' },
  { id: 'tencent',      name: 'Tencent TokenHub',          desc: 'Hy3 Preview via tokenhub.tencentmaas.com',      envKey: 'TENCENT_API_KEY' },
  { id: 'fireworks',    name: 'Fireworks AI',              desc: 'OpenAI-compatible direct model API',            envKey: 'FIREWORKS_API_KEY',   liveFetch: true },
  { id: 'arcee',        name: 'Arcee AI',                  desc: 'Trinity models, direct API',                    envKey: 'ARCEE_API_KEY' },
  { id: 'gmi',          name: 'GMI Cloud',                 desc: 'Multi-model direct API',                        envKey: 'GMI_API_KEY' },
  { id: 'kilocode',     name: 'Kilo Code',                 desc: 'Kilo Gateway API',                              envKey: 'KILOCODE_API_KEY' },
  { id: 'bedrock',      name: 'AWS Bedrock',               desc: 'Claude, Nova, Llama, DeepSeek; IAM or API key', envKey: 'AWS_ACCESS_KEY_ID' },
  { id: 'azure',        name: 'Azure Foundry',             desc: 'OpenAI-style or Anthropic-style endpoint',      envKey: 'AZURE_API_KEY' },
  { id: 'github',       name: 'GitHub Copilot',            desc: 'GitHub token API or copilot --acp process',     envKey: 'GITHUB_TOKEN' },
  { id: 'upstage',      name: 'Upstage',                   desc: 'Solar API',                                     envKey: 'UPSTAGE_API_KEY' },
  { id: 'alibaba',      name: 'Alibaba Cloud Coding Plan', desc: 'Dedicated coding tier',                         envKey: 'ALIBABA_API_KEY' },
  { id: 'custom',       name: 'Custom endpoint',           desc: 'Enter URL manually' },
];

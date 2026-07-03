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
 * again later to refresh (e.g. a future `:models refresh` REPL command).
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

import type { RubyConfig } from './types.js';
import { DEFAULT_RUBY_CONFIG } from './types.js';

interface OllamaTag {
  name: string;
  modified_at: string;
}

async function fetchLocalOllamaModels(ollamaBaseUrl: string): Promise<OllamaTag[]> {
  try {
    const root = ollamaBaseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${root}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
  }
}

export interface RubyConfigResolution {
  config: RubyConfig | null;
  reason: string;
}

/**
 * Resolves a usable RubyConfig. If .aura.json explicitly set a
 * modelName, that always wins with no network call. Otherwise, queries
 * Ollama for what's actually installed locally and uses the most
 * recently modified/used one. If nothing is installed at all, returns
 * null with setup guidance instead of a config that will 404.
 */
export async function resolveRubyConfig(
  fileRubyConfig: Partial<RubyConfig> | undefined,
): Promise<RubyConfigResolution> {
  const merged = { ...DEFAULT_RUBY_CONFIG, ...(fileRubyConfig ?? {}) };

  if (fileRubyConfig?.modelName) {
    return { config: merged, reason: `Using configured Ruby model: ${merged.modelName}` };
  }

  const models = await fetchLocalOllamaModels(merged.ollamaBaseUrl);
  if (models.length === 0) {
    return {
      config: null,
      reason:
        'No local Ollama models found — Ruby Alternator has nothing to route to.\n' +
        '  Run: ollama pull granite4.1:3b (or any model you prefer)\n' +
        '  It will be auto-detected next time, or set "ruby": { "modelName": "..." } in .aura.json.',
    };
  }

  const mostRecent = [...models].sort(
    (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
  )[0];

  return {
    config: { ...merged, modelName: mostRecent.name },
    reason: `No model configured — auto-detected most recently used local model: ${mostRecent.name}`,
  };
}

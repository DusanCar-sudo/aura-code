import type { ArchimedesConfig } from './types.js';
import { DEFAULT_ARCHIMEDES_CONFIG } from './types.js';
import {
  listLMStudioModels,
  listOllamaModels,
  resolveEndpoint,
  splitBackendPrefix,
  type LocalModel,
} from './endpoint.js';

/** In-memory cache entry, keyed by backend + base URL. */
interface CacheEntry {
  models: LocalModel[];
  timestamp: number;
}

const modelCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/** Discovery is cached for 60s so the CLI and TUI call sites share one fetch. */
async function cached(key: string, fetcher: () => Promise<LocalModel[]>): Promise<LocalModel[]> {
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) return hit.models;
  const models = await fetcher();
  modelCache.set(key, { models, timestamp: Date.now() });
  return models;
}

/** Clears the discovery cache. Test seam. */
export function clearLocalModelCache(): void {
  modelCache.clear();
}

/**
 * Ranks candidates for auto-selection. An already-loaded model wins outright:
 * on LM Studio, picking a cold model means Archimedes' first turn stalls for
 * however long the weights take to page in. Tool-calling capability comes next
 * (Archimedes drives an agent loop), then recency where the backend reports it.
 */
function betterCandidate(a: LocalModel, b: LocalModel): number {
  if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
  const aTools = a.toolUse === true;
  const bTools = b.toolUse === true;
  if (aTools !== bTools) return aTools ? -1 : 1;
  return b.recency - a.recency;
}

export interface ArchimedesConfigResolution {
  config: ArchimedesConfig | null;
  reason: string;
}

/**
 * Resolves a usable ArchimedesConfig. If .aura.json explicitly set a
 * modelName, that always wins with no network call. Otherwise, queries the
 * local model servers for what is actually installed and picks the best
 * candidate. If nothing is running at all, returns null with setup guidance
 * instead of a config that will 404.
 *
 * Both Ollama and LM Studio are probed. Discovery used to hit Ollama's
 * `/api/tags` alone, so a machine running only LM Studio reported "no local
 * models" and every task escalated to the large model, and a machine running
 * both silently ignored LM Studio.
 *
 * Responses are cached in-memory for 60 seconds so that both call sites in
 * cli/index.ts (CLI --auto and TUI mode) share the same fetch result without
 * redundant round-trips.
 */
export async function resolveArchimedesConfig(
  fileArchimedesConfig: Partial<ArchimedesConfig> | undefined,
): Promise<ArchimedesConfigResolution> {
  const merged = { ...DEFAULT_ARCHIMEDES_CONFIG, ...(fileArchimedesConfig ?? {}) };

  if (fileArchimedesConfig?.modelName) {
    // A prefixed id (`lmstudio/qwen/qwen3-1.7b`) both selects the backend and
    // is stripped here, so the wire request carries the bare model id.
    const { backend, modelName } = splitBackendPrefix(fileArchimedesConfig.modelName);
    const config: ArchimedesConfig = {
      ...merged,
      modelName,
      ...(backend ? { backend } : {}),
    };
    const { label } = resolveEndpoint(config);
    return { config, reason: `Using configured Archimedes model: ${modelName} (${label})` };
  }

  const ollamaEndpoint = resolveEndpoint({ ...merged, backend: 'ollama' });
  const lmstudioEndpoint = resolveEndpoint({ ...merged, backend: 'lmstudio' });

  const [ollamaModels, lmstudioModels] = await Promise.all([
    cached(`ollama:${ollamaEndpoint.baseUrl}`, () => listOllamaModels(ollamaEndpoint.baseUrl)),
    cached(`lmstudio:${lmstudioEndpoint.baseUrl}`, () => listLMStudioModels(lmstudioEndpoint.baseUrl)),
  ]);

  // Ollama first, so it wins ties at equal rank — continuity for setups that
  // worked before LM Studio was a candidate at all.
  const candidates = [...ollamaModels, ...lmstudioModels];
  if (candidates.length === 0) {
    return {
      config: null,
      reason:
        'No local models found on Ollama or LM Studio — Archimedes Alternator has nothing to route to.\n' +
        '  Ollama: run `ollama pull granite4.1:3b` (or any model you prefer)\n' +
        '  LM Studio: start the local server (Developer tab) and load a model\n' +
        '  Either is auto-detected next time, or set "archimedes": { "modelName": "lmstudio/<id>" } in .aura.json.',
    };
  }

  const best = [...candidates].sort(betterCandidate)[0];
  const endpoint = resolveEndpoint({ ...merged, backend: best.backend });
  const detail = best.loaded ? 'already loaded' : 'most recently used';

  return {
    config: { ...merged, modelName: best.name, backend: best.backend },
    reason: `No model configured — auto-detected ${detail} local model: ${best.name} (${endpoint.label})`,
  };
}

import type { ArchimedesBackend, ArchimedesConfig } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Archimedes local backends — Ollama and LM Studio
// ─────────────────────────────────────────────────────────────────────────────
//
// Archimedes was originally Ollama-only: one hard-coded base URL, one
// `/api/tags` discovery call, and `apiKey: 'ollama'` everywhere. LM Studio
// speaks the same OpenAI-compatible `/v1` dialect but serves a different
// discovery surface (`/api/v0/models`), so a user running LM Studio instead of
// Ollama got "no local models found" and every task escalated to the large
// model. This module is the single place that knows which local server we are
// talking to and how to reach it.

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';

/** How long a liveness/discovery probe may take before it counts as down. */
export const PROBE_TIMEOUT_MS = 3_000;

/** A resolved local endpoint: where to send completions and how to label it. */
export interface ArchimedesEndpoint {
  backend: ArchimedesBackend;
  /** OpenAI-compatible root, always ending in `/v1`. */
  baseUrl: string;
  /** Neither server authenticates, but both want a non-empty bearer token. */
  apiKey: string;
  /** Human-readable name for display lines. */
  label: string;
}

/** A model offered by a local server, normalised across both backends. */
export interface LocalModel {
  /** Id to send as `model` in a completion request. */
  name: string;
  backend: ArchimedesBackend;
  /** Sort key for "most recently used"; 0 when the backend does not report one. */
  recency: number;
  /** True when the backend says the weights are already resident in memory. */
  loaded: boolean;
  /** True when the backend advertises tool-calling. Undefined = unknown. */
  toolUse?: boolean;
}

/**
 * Normalises any base-URL spelling to the OpenAI-compatible `/v1` root.
 * Accepts `http://host:port`, `http://host:port/`, and `http://host:port/v1`
 * because `.aura.json`, `OLLAMA_BASE_URL` and `LMSTUDIO_BASE_URL` are each
 * documented with a different one of those three forms.
 */
export function normalizeV1(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Strips the `/v1` suffix — the native REST APIs live one level up. */
export function apiRoot(baseUrl: string): string {
  return (baseUrl ?? '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/**
 * Splits a routing prefix off a model id: `lmstudio/qwen/qwen3-1.7b` →
 * `{ backend: 'lmstudio', modelName: 'qwen/qwen3-1.7b' }`. Only the first
 * segment is consumed, so LM Studio's `publisher/model` ids survive intact.
 * Returns `backend: undefined` for an unprefixed id rather than guessing.
 */
export function splitBackendPrefix(
  modelName: string,
): { backend: ArchimedesBackend | undefined; modelName: string } {
  const raw = (modelName ?? '').trim();
  const m = /^(ollama|lmstudio|local)\/(.+)$/.exec(raw);
  if (!m) return { backend: undefined, modelName: raw };
  return {
    backend: m[1] === 'ollama' ? 'ollama' : 'lmstudio',
    modelName: m[2],
  };
}

/**
 * Resolves which local server a config points at. Precedence: an explicit
 * `backend`, then a routing prefix on `modelName`, then Ollama for
 * back-compat with every config written before LM Studio was supported.
 *
 * The returned `baseUrl` prefers the config field for the chosen backend,
 * then that backend's env var, then its default port.
 */
export function resolveEndpoint(config: Partial<ArchimedesConfig>): ArchimedesEndpoint {
  const backend =
    config.backend ?? splitBackendPrefix(config.modelName ?? '').backend ?? 'ollama';

  if (backend === 'lmstudio') {
    return {
      backend,
      baseUrl: normalizeV1(
        config.lmstudioBaseUrl || process.env.LMSTUDIO_BASE_URL || DEFAULT_LMSTUDIO_BASE_URL,
      ),
      apiKey: 'lm-studio',
      label: 'LM Studio',
    };
  }

  return {
    backend,
    baseUrl: normalizeV1(
      config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
    ),
    apiKey: 'ollama',
    label: 'Ollama',
  };
}

/**
 * Returns the model id with any routing prefix removed — what actually goes
 * on the wire. `lmstudio/qwen/qwen3-1.7b` → `qwen/qwen3-1.7b`.
 */
export function wireModelName(config: Pick<ArchimedesConfig, 'modelName'>): string {
  return splitBackendPrefix(config.modelName ?? '').modelName;
}

/**
 * Applies a runtime model override (`:archmodel`) onto a resolved config.
 * A prefixed override switches the backend too — without this, an override of
 * `lmstudio/qwen/qwen3-1.7b` would keep the `backend: 'ollama'` that
 * auto-detection had already written and send the request to the wrong port.
 * An unprefixed override leaves the existing backend alone.
 */
export function applyModelOverride(
  config: ArchimedesConfig,
  override: string | undefined,
): ArchimedesConfig {
  if (!override) return config;
  const { backend, modelName } = splitBackendPrefix(override);
  return { ...config, modelName, ...(backend ? { backend } : {}) };
}

async function getJson(url: string, apiKey: string): Promise<unknown | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a local server is up. Both backends serve `/v1/models`, so
 * one probe covers both. Never throws.
 */
export async function isEndpointAvailable(endpoint: ArchimedesEndpoint): Promise<boolean> {
  const body = await getJson(`${endpoint.baseUrl}/models`, endpoint.apiKey);
  return body !== undefined;
}

/**
 * Lists Ollama models via `/api/tags`. Returns `[]` when Ollama is down.
 * Never throws.
 */
export async function listOllamaModels(baseUrl: string): Promise<LocalModel[]> {
  const body = await getJson(`${apiRoot(baseUrl)}/api/tags`, 'ollama') as
    | { models?: { name?: string; modified_at?: string }[] }
    | undefined;
  if (!body || !Array.isArray(body.models)) return [];
  return body.models
    .filter((m): m is { name: string; modified_at?: string } => typeof m?.name === 'string')
    .map(m => ({
      name: m.name,
      backend: 'ollama' as const,
      recency: m.modified_at ? new Date(m.modified_at).getTime() || 0 : 0,
      // Ollama unloads on a timer and /api/tags does not report residency;
      // /api/ps does, but a second round-trip is not worth it here.
      loaded: false,
    }));
}

/**
 * Lists LM Studio models. Prefers the native `/api/v0/models`, which reports
 * `type`, `state` and `capabilities` — that lets us drop embedding and vision
 * models (Archimedes runs a tool-calling agent loop, not an encoder) and
 * prefer weights that are already resident. Falls back to the OpenAI-shaped
 * `/v1/models` on older LM Studio builds, where those fields do not exist and
 * every entry has to be taken at face value. Never throws.
 */
export async function listLMStudioModels(baseUrl: string): Promise<LocalModel[]> {
  const native = await getJson(`${apiRoot(baseUrl)}/api/v0/models`, 'lm-studio') as
    | {
        data?: {
          id?: string;
          type?: string;
          state?: string;
          capabilities?: string[];
        }[];
      }
    | undefined;

  if (native && Array.isArray(native.data)) {
    return native.data
      .filter((m): m is { id: string; type?: string; state?: string; capabilities?: string[] } =>
        typeof m?.id === 'string')
      // `llm` and `vlm` can both drive the loop; `embeddings` cannot.
      .filter(m => m.type === undefined || m.type === 'llm' || m.type === 'vlm')
      .map(m => ({
        name: m.id,
        backend: 'lmstudio' as const,
        recency: 0,
        loaded: m.state === 'loaded',
        toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : undefined,
      }));
  }

  const openai = await getJson(`${normalizeV1(baseUrl)}/models`, 'lm-studio') as
    | { data?: { id?: string }[] }
    | undefined;
  if (!openai || !Array.isArray(openai.data)) return [];
  return openai.data
    .filter((m): m is { id: string } => typeof m?.id === 'string')
    .map(m => ({ name: m.id, backend: 'lmstudio' as const, recency: 0, loaded: false }));
}

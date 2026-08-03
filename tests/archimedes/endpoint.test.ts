import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyModelOverride,
  apiRoot,
  isEndpointAvailable,
  listLMStudioModels,
  listOllamaModels,
  normalizeV1,
  resolveEndpoint,
  splitBackendPrefix,
  wireModelName,
  DEFAULT_LMSTUDIO_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
} from '../../src/archimedes/endpoint.js';
import type { ArchimedesConfig } from '../../src/archimedes/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const baseConfig: ArchimedesConfig = {
  modelName: 'qwen2.5-coder:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  lmstudioBaseUrl: 'http://localhost:1234/v1',
  competenceThreshold: 0.7,
  minAttempts: 3,
  enabled: true,
  epsilonProbeRate: 0.05,
};

/** resolveEndpoint consults env vars, so they must not leak between tests. */
const savedEnv = { ollama: process.env.OLLAMA_BASE_URL, lmstudio: process.env.LMSTUDIO_BASE_URL };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.LMSTUDIO_BASE_URL;
});

afterEach(() => {
  if (savedEnv.ollama === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = savedEnv.ollama;
  if (savedEnv.lmstudio === undefined) delete process.env.LMSTUDIO_BASE_URL;
  else process.env.LMSTUDIO_BASE_URL = savedEnv.lmstudio;
});

function jsonOnce(body: unknown, ok = true): void {
  mockFetch.mockResolvedValueOnce({ ok, json: async () => body });
}

// ─────────────────────────────────────────────────────────────────────────────
// URL normalisation
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeV1', () => {
  it('appends /v1 to a bare host:port', () => {
    expect(normalizeV1('http://localhost:1234')).toBe('http://localhost:1234/v1');
  });

  it('leaves an existing /v1 alone', () => {
    expect(normalizeV1('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
  });

  it('strips trailing slashes before deciding', () => {
    expect(normalizeV1('http://localhost:1234/')).toBe('http://localhost:1234/v1');
    expect(normalizeV1('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeV1('')).toBe('');
  });
});

describe('apiRoot', () => {
  it('strips the /v1 suffix', () => {
    expect(apiRoot('http://localhost:1234/v1')).toBe('http://localhost:1234');
  });

  it('is a no-op on a bare host', () => {
    expect(apiRoot('http://localhost:11434')).toBe('http://localhost:11434');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend prefixes
// ─────────────────────────────────────────────────────────────────────────────
describe('splitBackendPrefix', () => {
  it('reads an lmstudio/ prefix', () => {
    expect(splitBackendPrefix('lmstudio/granite-4-1-3b')).toEqual({
      backend: 'lmstudio',
      modelName: 'granite-4-1-3b',
    });
  });

  it('treats local/ as LM Studio, matching the main model router', () => {
    expect(splitBackendPrefix('local/foo')).toEqual({ backend: 'lmstudio', modelName: 'foo' });
  });

  it('reads an ollama/ prefix', () => {
    expect(splitBackendPrefix('ollama/qwen3:4b')).toEqual({
      backend: 'ollama',
      modelName: 'qwen3:4b',
    });
  });

  it('consumes only the first segment, so publisher/model ids survive', () => {
    expect(splitBackendPrefix('lmstudio/qwen/qwen3-1.7b')).toEqual({
      backend: 'lmstudio',
      modelName: 'qwen/qwen3-1.7b',
    });
  });

  it('leaves an unprefixed publisher/model id untouched rather than guessing', () => {
    expect(splitBackendPrefix('qwen/qwen3-1.7b')).toEqual({
      backend: undefined,
      modelName: 'qwen/qwen3-1.7b',
    });
  });

  it('leaves a bare Ollama tag untouched', () => {
    expect(splitBackendPrefix('qwen2.5-coder:1.5b')).toEqual({
      backend: undefined,
      modelName: 'qwen2.5-coder:1.5b',
    });
  });
});

describe('wireModelName', () => {
  it('strips the routing prefix', () => {
    expect(wireModelName({ modelName: 'lmstudio/qwen/qwen3-1.7b' })).toBe('qwen/qwen3-1.7b');
  });

  it('passes an unprefixed id through', () => {
    expect(wireModelName({ modelName: 'qwen2.5-coder:1.5b' })).toBe('qwen2.5-coder:1.5b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint resolution
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveEndpoint', () => {
  it('defaults to Ollama for configs written before LM Studio existed', () => {
    const ep = resolveEndpoint({ modelName: 'qwen2.5-coder:1.5b' });
    expect(ep.backend).toBe('ollama');
    expect(ep.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(ep.apiKey).toBe('ollama');
  });

  it('infers LM Studio from a modelName prefix', () => {
    const ep = resolveEndpoint({ ...baseConfig, modelName: 'lmstudio/granite' });
    expect(ep.backend).toBe('lmstudio');
    expect(ep.baseUrl).toBe('http://localhost:1234/v1');
    expect(ep.apiKey).toBe('lm-studio');
    expect(ep.label).toBe('LM Studio');
  });

  it('lets an explicit backend win over the prefix', () => {
    const ep = resolveEndpoint({ ...baseConfig, backend: 'ollama', modelName: 'lmstudio/x' });
    expect(ep.backend).toBe('ollama');
  });

  it('falls back to the default LM Studio port when no URL is configured', () => {
    const ep = resolveEndpoint({ modelName: 'x', backend: 'lmstudio', ollamaBaseUrl: '' });
    expect(ep.baseUrl).toBe(DEFAULT_LMSTUDIO_BASE_URL);
  });

  it('honours LMSTUDIO_BASE_URL, including the bare host:port form', () => {
    process.env.LMSTUDIO_BASE_URL = 'http://192.168.1.9:1234';
    const ep = resolveEndpoint({ modelName: 'x', backend: 'lmstudio', ollamaBaseUrl: '' });
    expect(ep.baseUrl).toBe('http://192.168.1.9:1234/v1');
  });

  it('prefers the config field over the env var', () => {
    process.env.LMSTUDIO_BASE_URL = 'http://from-env:1234';
    const ep = resolveEndpoint({
      modelName: 'x',
      backend: 'lmstudio',
      ollamaBaseUrl: '',
      lmstudioBaseUrl: 'http://from-config:1234',
    });
    expect(ep.baseUrl).toBe('http://from-config:1234/v1');
  });

  it('does not let the LM Studio URL leak into the Ollama endpoint', () => {
    const ep = resolveEndpoint({ ...baseConfig, backend: 'ollama' });
    expect(ep.baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('applyModelOverride', () => {
  it('returns the config untouched when there is no override', () => {
    expect(applyModelOverride(baseConfig, undefined)).toBe(baseConfig);
  });

  it('switches the backend when the override is prefixed', () => {
    // Regression: auto-detection writes backend:'ollama', and a bare
    // { modelName } spread would keep it — sending an LM Studio id to :11434.
    const detected: ArchimedesConfig = { ...baseConfig, backend: 'ollama' };
    const out = applyModelOverride(detected, 'lmstudio/qwen/qwen3-1.7b');
    expect(out.backend).toBe('lmstudio');
    expect(out.modelName).toBe('qwen/qwen3-1.7b');
    expect(resolveEndpoint(out).baseUrl).toBe('http://localhost:1234/v1');
  });

  it('keeps the existing backend when the override is unprefixed', () => {
    const detected: ArchimedesConfig = { ...baseConfig, backend: 'lmstudio' };
    const out = applyModelOverride(detected, 'granite-4-1-3b');
    expect(out.backend).toBe('lmstudio');
    expect(out.modelName).toBe('granite-4-1-3b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Liveness
// ─────────────────────────────────────────────────────────────────────────────
describe('isEndpointAvailable', () => {
  it('probes /v1/models, which both backends serve', async () => {
    jsonOnce({ data: [] });
    const ep = resolveEndpoint({ ...baseConfig, backend: 'lmstudio' });
    expect(await isEndpointAvailable(ep)).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:1234/v1/models');
  });

  it('returns false when the server is down', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await isEndpointAvailable(resolveEndpoint(baseConfig))).toBe(false);
  });

  it('returns false on a non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await isEndpointAvailable(resolveEndpoint(baseConfig))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────
describe('listOllamaModels', () => {
  it('maps /api/tags entries and parses modified_at into a sort key', async () => {
    jsonOnce({
      models: [
        { name: 'kolibri:latest', modified_at: '2026-07-27T16:04:01.000Z' },
        { name: 'qwen3:4b', modified_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const models = await listOllamaModels('http://localhost:11434/v1');
    expect(models.map(m => m.name)).toEqual(['kolibri:latest', 'qwen3:4b']);
    expect(models.every(m => m.backend === 'ollama')).toBe(true);
    expect(models[0].recency).toBeGreaterThan(models[1].recency);
  });

  it('calls /api/tags on the root, not under /v1', async () => {
    jsonOnce({ models: [] });
    await listOllamaModels('http://localhost:11434/v1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
  });

  it('returns [] when Ollama is down', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await listOllamaModels('http://localhost:11434/v1')).toEqual([]);
  });
});

describe('listLMStudioModels', () => {
  it('reads /api/v0/models and reports loaded + tool_use', async () => {
    jsonOnce({
      data: [
        { id: 'granite', type: 'llm', state: 'loaded', capabilities: ['tool_use'] },
        { id: 'qwen/qwen3-1.7b', type: 'llm', state: 'not-loaded', capabilities: ['tool_use'] },
      ],
    });
    const models = await listLMStudioModels('http://localhost:1234/v1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:1234/api/v0/models');
    expect(models[0]).toMatchObject({ name: 'granite', loaded: true, toolUse: true });
    expect(models[1]).toMatchObject({ name: 'qwen/qwen3-1.7b', loaded: false });
  });

  it('drops embedding models, which cannot drive the agent loop', async () => {
    jsonOnce({
      data: [
        { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', state: 'not-loaded' },
        { id: 'granite', type: 'llm', state: 'loaded' },
      ],
    });
    const models = await listLMStudioModels('http://localhost:1234/v1');
    expect(models.map(m => m.name)).toEqual(['granite']);
  });

  it('keeps vision models — a vlm can still run the loop', async () => {
    jsonOnce({ data: [{ id: 'granite-vision-4.1-4b', type: 'vlm', state: 'not-loaded' }] });
    const models = await listLMStudioModels('http://localhost:1234/v1');
    expect(models.map(m => m.name)).toEqual(['granite-vision-4.1-4b']);
  });

  it('falls back to /v1/models on builds without the native REST API', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    jsonOnce({ data: [{ id: 'granite' }, { id: 'qwen/qwen3-1.7b' }] });
    const models = await listLMStudioModels('http://localhost:1234/v1');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:1234/v1/models');
    expect(models.map(m => m.name)).toEqual(['granite', 'qwen/qwen3-1.7b']);
    expect(models.every(m => m.loaded === false)).toBe(true);
  });

  it('returns [] when LM Studio is down', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await listLMStudioModels('http://localhost:1234/v1')).toEqual([]);
  });
});

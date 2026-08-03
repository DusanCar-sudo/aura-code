import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveArchimedesConfig,
  clearLocalModelCache,
} from '../../src/archimedes/resolve-config.js';
import { resolveEndpoint } from '../../src/archimedes/endpoint.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const savedEnv = { ollama: process.env.OLLAMA_BASE_URL, lmstudio: process.env.LMSTUDIO_BASE_URL };

beforeEach(() => {
  vi.clearAllMocks();
  clearLocalModelCache();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.LMSTUDIO_BASE_URL;
});

afterEach(() => {
  if (savedEnv.ollama === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = savedEnv.ollama;
  if (savedEnv.lmstudio === undefined) delete process.env.LMSTUDIO_BASE_URL;
  else process.env.LMSTUDIO_BASE_URL = savedEnv.lmstudio;
});

/**
 * Routes the two discovery calls by URL. Discovery runs them concurrently, so
 * mockResolvedValueOnce ordering is not reliable here.
 */
function serve(opts: {
  ollama?: { name: string; modified_at?: string }[] | 'down';
  lmstudio?: { id: string; type?: string; state?: string; capabilities?: string[] }[] | 'down';
}): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/tags')) {
      if (opts.ollama === undefined || opts.ollama === 'down') throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: opts.ollama }) };
    }
    if (url.includes('/api/v0/models') || url.includes('/v1/models')) {
      if (opts.lmstudio === undefined || opts.lmstudio === 'down') throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ data: opts.lmstudio }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detection
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveArchimedesConfig — auto-detection', () => {
  it('finds an LM Studio model when only LM Studio is running', async () => {
    // The original regression: discovery hit Ollama's /api/tags alone, so an
    // LM Studio-only machine reported "no local models" and always escalated.
    serve({ ollama: 'down', lmstudio: [{ id: 'granite', type: 'llm', state: 'loaded' }] });

    const { config, reason } = await resolveArchimedesConfig(undefined);
    expect(config).not.toBeNull();
    expect(config!.backend).toBe('lmstudio');
    expect(config!.modelName).toBe('granite');
    expect(reason).toContain('LM Studio');
    expect(resolveEndpoint(config!).baseUrl).toBe('http://localhost:1234/v1');
  });

  it('still finds an Ollama model when only Ollama is running', async () => {
    serve({
      ollama: [{ name: 'kolibri:latest', modified_at: '2026-07-27T16:04:01.000Z' }],
      lmstudio: 'down',
    });

    const { config, reason } = await resolveArchimedesConfig(undefined);
    expect(config!.backend).toBe('ollama');
    expect(config!.modelName).toBe('kolibri:latest');
    expect(reason).toContain('Ollama');
    expect(resolveEndpoint(config!).baseUrl).toBe('http://localhost:11434/v1');
  });

  it('prefers an already-loaded LM Studio model over a cold Ollama one', async () => {
    serve({
      ollama: [{ name: 'kolibri:latest', modified_at: '2026-07-27T16:04:01.000Z' }],
      lmstudio: [{ id: 'granite', type: 'llm', state: 'loaded' }],
    });

    const { config, reason } = await resolveArchimedesConfig(undefined);
    expect(config!.backend).toBe('lmstudio');
    expect(config!.modelName).toBe('granite');
    expect(reason).toContain('already loaded');
  });

  it('prefers Ollama at equal rank, for continuity with existing setups', async () => {
    serve({
      ollama: [{ name: 'kolibri:latest', modified_at: '2026-07-27T16:04:01.000Z' }],
      lmstudio: [{ id: 'granite', type: 'llm', state: 'not-loaded' }],
    });

    const { config } = await resolveArchimedesConfig(undefined);
    expect(config!.backend).toBe('ollama');
  });

  it('prefers a tool-capable LM Studio model when none are loaded', async () => {
    serve({
      ollama: 'down',
      lmstudio: [
        { id: 'no-tools', type: 'llm', state: 'not-loaded' },
        { id: 'with-tools', type: 'llm', state: 'not-loaded', capabilities: ['tool_use'] },
      ],
    });

    const { config } = await resolveArchimedesConfig(undefined);
    expect(config!.modelName).toBe('with-tools');
  });

  it('returns null with guidance naming both servers when neither is up', async () => {
    serve({ ollama: 'down', lmstudio: 'down' });

    const { config, reason } = await resolveArchimedesConfig(undefined);
    expect(config).toBeNull();
    expect(reason).toContain('Ollama');
    expect(reason).toContain('LM Studio');
  });

  it('caches discovery so the CLI and TUI call sites share one fetch', async () => {
    serve({ ollama: 'down', lmstudio: [{ id: 'granite', type: 'llm', state: 'loaded' }] });

    await resolveArchimedesConfig(undefined);
    const afterFirst = mockFetch.mock.calls.length;
    await resolveArchimedesConfig(undefined);
    expect(mockFetch.mock.calls.length).toBe(afterFirst);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit configuration
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveArchimedesConfig — explicit modelName', () => {
  it('routes an lmstudio/-prefixed id to LM Studio with no network call', async () => {
    serve({ ollama: 'down', lmstudio: 'down' });

    const { config, reason } = await resolveArchimedesConfig({
      modelName: 'lmstudio/qwen/qwen3-1.7b',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(config!.backend).toBe('lmstudio');
    // The prefix is stripped — the wire request must carry the bare id.
    expect(config!.modelName).toBe('qwen/qwen3-1.7b');
    expect(reason).toContain('LM Studio');
  });

  it('honours an explicit backend without a prefix', async () => {
    const { config } = await resolveArchimedesConfig({
      modelName: 'granite',
      backend: 'lmstudio',
    });
    expect(resolveEndpoint(config!).baseUrl).toBe('http://localhost:1234/v1');
  });

  it('honours a custom lmstudioBaseUrl', async () => {
    const { config } = await resolveArchimedesConfig({
      modelName: 'lmstudio/granite',
      lmstudioBaseUrl: 'http://192.168.1.9:4321',
    });
    expect(resolveEndpoint(config!).baseUrl).toBe('http://192.168.1.9:4321/v1');
  });

  it('keeps an unprefixed id on Ollama, as before LM Studio was supported', async () => {
    const { config, reason } = await resolveArchimedesConfig({ modelName: 'qwen2.5-coder:1.5b' });
    expect(config!.modelName).toBe('qwen2.5-coder:1.5b');
    expect(resolveEndpoint(config!).baseUrl).toBe('http://localhost:11434/v1');
    expect(reason).toContain('Ollama');
  });
});

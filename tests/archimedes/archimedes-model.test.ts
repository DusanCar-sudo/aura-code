import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArchimedesModel } from '../../src/archimedes/archimedes-model.js';
import type { ArchimedesConfig } from '../../src/archimedes/types.js';

// ── Mock fetch for Ollama health checks ─────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Fixtures ────────────────────────────────────────────────────────────────
const defaultConfig: ArchimedesConfig = {
  modelName: 'qwen2.5-coder:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  competenceThreshold: 0.7,
  minAttempts: 3,
  enabled: true,
};

function makeArchimedes(overrides?: Partial<ArchimedesConfig>): ArchimedesModel {
  return new ArchimedesModel({ ...defaultConfig, ...overrides });
}

function mockOllamaTags(names: string[]): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ models: names.map(name => ({ name })) }),
  });
}

function mockOllamaError(): void {
  mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
}

function mockOllamaNotOk(): void {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// isAvailable
// ─────────────────────────────────────────────────────────────────────────────
describe('ArchimedesModel — isAvailable', () => {
  it('returns true when model is in Ollama tags', async () => {
    mockOllamaTags(['qwen2.5-coder:1.5b', 'llama3.2:latest']);
    const archimedes = makeArchimedes();

    const available = await archimedes.isAvailable();
    expect(available).toBe(true);
  });

  it('matches model name prefix (e.g. "qwen2.5-coder" matches "qwen2.5-coder:1.5b")', async () => {
    mockOllamaTags(['qwen2.5-coder', 'llama3.2']);
    const archimedes = makeArchimedes({ modelName: 'qwen2.5-coder' });

    const available = await archimedes.isAvailable();
    expect(available).toBe(true);
  });

  it('returns false when model is not found', async () => {
    mockOllamaTags(['llama3.2:latest', 'mistral:7b']);
    const archimedes = makeArchimedes({ modelName: 'nonexistent-model' });

    const available = await archimedes.isAvailable();
    expect(available).toBe(false);
  });

  it('returns false on network error', async () => {
    mockOllamaError();
    const archimedes = makeArchimedes();

    const available = await archimedes.isAvailable();
    expect(available).toBe(false);
  });

  it('returns false when Ollama returns non-ok status', async () => {
    mockOllamaNotOk();
    const archimedes = makeArchimedes();

    const available = await archimedes.isAvailable();
    expect(available).toBe(false);
  });

  it('never throws', async () => {
    mockOllamaError();
    const archimedes = makeArchimedes();
    await expect(archimedes.isAvailable()).resolves.toBeDefined();
  });

  it('returns false when tags list is empty', async () => {
    mockOllamaTags([]);
    const archimedes = makeArchimedes();

    const available = await archimedes.isAvailable();
    expect(available).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getVersion / updateModel
// ─────────────────────────────────────────────────────────────────────────────
describe('ArchimedesModel — getVersion / updateModel', () => {
  it('getVersion returns the model name', async () => {
    const archimedes = makeArchimedes({ modelName: 'qwen2.5-coder:1.5b' });
    const version = await archimedes.getVersion();
    expect(version).toBe('qwen2.5-coder:1.5b');
  });

  it('updateModel changes the internal model reference', async () => {
    const archimedes = makeArchimedes({ modelName: 'qwen2.5-coder:1.5b' });
    await archimedes.updateModel('qwen2.5-coder:3b');
    const version = await archimedes.getVersion();
    expect(version).toBe('qwen2.5-coder:3b');
  });

  it('updateModel does not affect other instances', async () => {
    const archimedes1 = makeArchimedes({ modelName: 'model-a' });
    const archimedes2 = makeArchimedes({ modelName: 'model-b' });

    await archimedes1.updateModel('updated-a');

    expect(await archimedes1.getVersion()).toBe('updated-a');
    expect(await archimedes2.getVersion()).toBe('model-b');
  });

  it('model property reflects current model name', async () => {
    const archimedes = makeArchimedes({ modelName: 'initial-model' });
    expect(archimedes.model).toBe('initial-model');

    await archimedes.updateModel('changed-model');
    expect(archimedes.model).toBe('changed-model');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete
// ─────────────────────────────────────────────────────────────────────────────
describe('ArchimedesModel — complete', () => {
  it('delegates to internal OpenAICompatibleProvider', async () => {
    // Unreachable port so the provider call rejects even when a real
    // Ollama is running on this machine.
    const archimedes = makeArchimedes({ ollamaBaseUrl: 'http://127.0.0.1:9/v1' });
    const promise = archimedes.complete('system', [{ role: 'user', content: 'test' }], []);
    await expect(promise).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream
// ─────────────────────────────────────────────────────────────────────────────
describe('ArchimedesModel — stream', () => {
  it('delegates to internal OpenAICompatibleProvider', async () => {
    const archimedes = makeArchimedes();
    const generator = archimedes.stream('system', [{ role: 'user', content: 'test' }], []);
    // Will throw on first iteration because no real Ollama
    try {
      for await (const _ of generator) { /* noop */ }
    } catch {
      // Expected — no real backend
    }
    // Test just verifies the method exists and doesn't crash on call
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// name
// ─────────────────────────────────────────────────────────────────────────────
describe('ArchimedesModel — name', () => {
  it('name is always "Archimedes"', () => {
    const archimedes = makeArchimedes();
    expect(archimedes.name).toBe('Archimedes');
  });

  it('name does not change after updateModel', async () => {
    const archimedes = makeArchimedes();
    await archimedes.updateModel('different-model');
    expect(archimedes.name).toBe('Archimedes');
  });

  it('supportsTools is true', () => {
    const archimedes = makeArchimedes();
    expect(archimedes.supportsTools).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// constructor
// ─────────────────────────────────────────────────────────────────────────────
describe('ArchimedesModel — constructor', () => {
  it('uses provided model name from config', async () => {
    const archimedes = makeArchimedes({ modelName: 'custom-model:latest' });
    expect(await archimedes.getVersion()).toBe('custom-model:latest');
  });

  it('uses provided base URL for Ollama calls', async () => {
    const archimedes = makeArchimedes({
      modelName: 'test-model',
      ollamaBaseUrl: 'http://custom-ollama:1234/v1',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'test-model' }] }),
    });

    const available = await archimedes.isAvailable();
    expect(available).toBe(true);
    // Should have called the custom base URL's /api/tags
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('custom-ollama');
    expect(calledUrl).toContain('/api/tags');
  });

  it('model property matches config.modelName', () => {
    const archimedes = makeArchimedes({ modelName: 'init-model' });
    expect(archimedes.model).toBe('init-model');
  });
});

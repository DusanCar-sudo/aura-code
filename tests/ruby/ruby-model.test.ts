import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RubyModel } from '../../src/ruby/ruby-model.js';
import type { RubyConfig } from '../../src/ruby/types.js';

// ── Mock fetch for Ollama health checks ─────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Fixtures ────────────────────────────────────────────────────────────────
const defaultConfig: RubyConfig = {
  modelName: 'qwen2.5-coder:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  competenceThreshold: 0.7,
  minAttempts: 3,
  enabled: true,
};

function makeRuby(overrides?: Partial<RubyConfig>): RubyModel {
  return new RubyModel({ ...defaultConfig, ...overrides });
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
describe('RubyModel — isAvailable', () => {
  it('returns true when model is in Ollama tags', async () => {
    mockOllamaTags(['qwen2.5-coder:1.5b', 'llama3.2:latest']);
    const ruby = makeRuby();

    const available = await ruby.isAvailable();
    expect(available).toBe(true);
  });

  it('matches model name prefix (e.g. "qwen2.5-coder" matches "qwen2.5-coder:1.5b")', async () => {
    mockOllamaTags(['qwen2.5-coder', 'llama3.2']);
    const ruby = makeRuby({ modelName: 'qwen2.5-coder' });

    const available = await ruby.isAvailable();
    expect(available).toBe(true);
  });

  it('returns false when model is not found', async () => {
    mockOllamaTags(['llama3.2:latest', 'mistral:7b']);
    const ruby = makeRuby({ modelName: 'nonexistent-model' });

    const available = await ruby.isAvailable();
    expect(available).toBe(false);
  });

  it('returns false on network error', async () => {
    mockOllamaError();
    const ruby = makeRuby();

    const available = await ruby.isAvailable();
    expect(available).toBe(false);
  });

  it('returns false when Ollama returns non-ok status', async () => {
    mockOllamaNotOk();
    const ruby = makeRuby();

    const available = await ruby.isAvailable();
    expect(available).toBe(false);
  });

  it('never throws', async () => {
    mockOllamaError();
    const ruby = makeRuby();
    await expect(ruby.isAvailable()).resolves.toBeDefined();
  });

  it('returns false when tags list is empty', async () => {
    mockOllamaTags([]);
    const ruby = makeRuby();

    const available = await ruby.isAvailable();
    expect(available).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getVersion / updateModel
// ─────────────────────────────────────────────────────────────────────────────
describe('RubyModel — getVersion / updateModel', () => {
  it('getVersion returns the model name', async () => {
    const ruby = makeRuby({ modelName: 'qwen2.5-coder:1.5b' });
    const version = await ruby.getVersion();
    expect(version).toBe('qwen2.5-coder:1.5b');
  });

  it('updateModel changes the internal model reference', async () => {
    const ruby = makeRuby({ modelName: 'qwen2.5-coder:1.5b' });
    await ruby.updateModel('qwen2.5-coder:3b');
    const version = await ruby.getVersion();
    expect(version).toBe('qwen2.5-coder:3b');
  });

  it('updateModel does not affect other instances', async () => {
    const ruby1 = makeRuby({ modelName: 'model-a' });
    const ruby2 = makeRuby({ modelName: 'model-b' });

    await ruby1.updateModel('updated-a');

    expect(await ruby1.getVersion()).toBe('updated-a');
    expect(await ruby2.getVersion()).toBe('model-b');
  });

  it('model property reflects current model name', async () => {
    const ruby = makeRuby({ modelName: 'initial-model' });
    expect(ruby.model).toBe('initial-model');

    await ruby.updateModel('changed-model');
    expect(ruby.model).toBe('changed-model');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete
// ─────────────────────────────────────────────────────────────────────────────
describe('RubyModel — complete', () => {
  it('delegates to internal OpenAICompatibleProvider', async () => {
    const ruby = makeRuby();
    // The complete method delegates to the OpenAICompatibleProvider.
    // Without mocking fetch, it will try to reach Ollama and fail.
    // We test that the method exists and is callable.
    const promise = ruby.complete('system', [{ role: 'user', content: 'test' }], []);
    // Will reject because no real Ollama, but the method exists
    await expect(promise).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream
// ─────────────────────────────────────────────────────────────────────────────
describe('RubyModel — stream', () => {
  it('delegates to internal OpenAICompatibleProvider', async () => {
    const ruby = makeRuby();
    const generator = ruby.stream('system', [{ role: 'user', content: 'test' }], []);
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
describe('RubyModel — name', () => {
  it('name is always "Ruby"', () => {
    const ruby = makeRuby();
    expect(ruby.name).toBe('Ruby');
  });

  it('name does not change after updateModel', async () => {
    const ruby = makeRuby();
    await ruby.updateModel('different-model');
    expect(ruby.name).toBe('Ruby');
  });

  it('supportsTools is true', () => {
    const ruby = makeRuby();
    expect(ruby.supportsTools).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// constructor
// ─────────────────────────────────────────────────────────────────────────────
describe('RubyModel — constructor', () => {
  it('uses provided model name from config', async () => {
    const ruby = makeRuby({ modelName: 'custom-model:latest' });
    expect(await ruby.getVersion()).toBe('custom-model:latest');
  });

  it('uses provided base URL for Ollama calls', async () => {
    const ruby = makeRuby({
      modelName: 'test-model',
      ollamaBaseUrl: 'http://custom-ollama:1234/v1',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'test-model' }] }),
    });

    const available = await ruby.isAvailable();
    expect(available).toBe(true);
    // Should have called the custom base URL's /api/tags
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('custom-ollama');
    expect(calledUrl).toContain('/api/tags');
  });

  it('model property matches config.modelName', () => {
    const ruby = makeRuby({ modelName: 'init-model' });
    expect(ruby.model).toBe('init-model');
  });
});

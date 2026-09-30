import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAllModels, isModelConfigured, LOCAL_ONLY_PROVIDERS } from '../../src/providers/factory.js';

/**
 * Regression cover for the Telegram /model work.
 *
 * 1. Local model servers (Ollama / LM Studio) used to be reported as
 *    "configured" purely because the id had the right prefix, so /models
 *    advertised ~19 entries that 401'd on first use. They now require a
 *    reachable server.
 * 2. LOCAL_ONLY_PROVIDERS must stay in sync with those prefixes — the
 *    /model listing filters on it to group remote providers only.
 */
describe('model listing: local servers are not "configured" when down', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL']) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does not claim ollama models are configured when nothing is listening', () => {
    // 127.0.0.1:1 is reserved and never accepts connections, which stands in
    // for "no model server running on this machine".
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:1';
    expect(isModelConfigured('ollama/llama3.2')).toBe(false);
    expect(isModelConfigured('lmstudio/local-model')).toBe(false);
    expect(isModelConfigured('local/something')).toBe(false);
  });

  it('keeps cloud models configured when a key is present', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-not-a-real-key';
    expect(isModelConfigured('deepseek-v4-flash')).toBe(true);
  });

  it('exposes the local-only provider names the listing filters on', () => {
    expect(LOCAL_ONLY_PROVIDERS).toContain('Ollama');
    expect(LOCAL_ONLY_PROVIDERS).toContain('Local');
  });

  it('never lists a local-only model as configured while the server is down', () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:1';
    const leaked = getAllModels()
      .filter(m => isModelConfigured(m.id))
      .filter(m => LOCAL_ONLY_PROVIDERS.includes(m.provider));
    expect(leaked).toEqual([]);
  });
});

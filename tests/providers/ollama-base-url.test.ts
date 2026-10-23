import { describe, it, expect, afterEach } from 'vitest';
import { createProvider } from '../../src/providers/factory.js';

const ORIGINAL = process.env.OLLAMA_BASE_URL;

function clientBaseUrl(model: string): string {
  const provider = createProvider({ model }) as unknown as { client: { baseURL: string } };
  return provider.client.baseURL;
}

describe('Ollama base URL', () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = ORIGINAL;
  });

  it('adds http:// and /v1 to a bare host:port saved in OLLAMA_BASE_URL', () => {
    process.env.OLLAMA_BASE_URL = '127.0.0.1:11434';
    expect(clientBaseUrl('ollama/gemma3-tools:1b')).toBe('http://127.0.0.1:11434/v1');
  });

  it('keeps a bare host:port that already has /v1 and only adds the scheme', () => {
    process.env.OLLAMA_BASE_URL = '127.0.0.1:11434/v1';
    expect(clientBaseUrl('ollama/gemma3-tools:1b')).toBe('http://127.0.0.1:11434/v1');
  });

  it('leaves a full URL unchanged', () => {
    process.env.OLLAMA_BASE_URL = 'http://192.168.1.5:11434/';
    expect(clientBaseUrl('ollama/gemma3-tools:1b')).toBe('http://192.168.1.5:11434/v1');
  });
});

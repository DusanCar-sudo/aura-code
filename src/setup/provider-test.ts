/**
 * Provider connection tester.
 *
 * Sends a minimal API request to verify the key works for a given provider.
 * Handles different auth formats:
 *   - Anthropic: x-api-key header
 *   - Google: ?key= query param
 *   - All others: standard Bearer token
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface ProviderTestConfig {
  provider: string;  // Display name (e.g. "DeepSeek", "Anthropic (Claude)")
  model: string;     // Model ID
  baseUrl: string;   // API endpoint
  apiKey?: string;   // API key (optional for Ollama)
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

/**
 * Test a provider connection by sending a minimal chat completion request.
 * Times out after 10 seconds.
 */
export async function testProviderConnection(config: ProviderTestConfig): Promise<TestResult> {
  const isOllama = config.provider === 'Ollama (local, free)';
  const isAnthropic = config.provider === 'Anthropic (Claude)';
  const isGoogle = config.provider === 'Google (Gemini)';

  // ── Ollama: just check if the server is reachable ──────────────────────────
  if (isOllama) {
    return testOllamaConnection(config.baseUrl);
  }

  // ── Google: uses a different API format ────────────────────────────────────
  if (isGoogle) {
    return testGoogleConnection(config);
  }

  // ── Anthropic: uses x-api-key header and different body format ─────────────
  if (isAnthropic) {
    return testAnthropicConnection(config);
  }

  // ── All others: OpenAI-compatible chat/completions ─────────────────────────
  return testOpenAICompatibleConnection(config);
}

/**
 * Check if Ollama is running by fetching /api/tags.
 */
async function testOllamaConnection(baseUrl: string): Promise<TestResult> {
  // Ollama's base is e.g. http://localhost:11434/v1 — we need the root
  const root = baseUrl.replace(/\/v1\/?$/, '');
  return new Promise(resolve => {
    const req = http.get(`${root}/api/tags`, { timeout: 10_000 }, res => {
      if (res.statusCode === 200) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `Ollama responded with HTTP ${res.statusCode}` });
      }
      res.resume();
    });
    req.on('error', (e: Error) => {
      resolve({
        ok: false,
        error: `Ollama doesn't seem to be running. Start it first: ollama serve (${e.message})`,
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timed out after 10 seconds' });
    });
  });
}

/**
 * Test Google Generative AI connection using generateContent endpoint.
 */
async function testGoogleConnection(config: ProviderTestConfig): Promise<TestResult> {
  const url = new URL(
    `${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`,
  );

  const body = JSON.stringify({
    contents: [{ parts: [{ text: "Say 'ok' and nothing else" }] }],
    generationConfig: { maxOutputTokens: 10 },
  });

  return makeRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

/**
 * Test Anthropic connection using their Messages API.
 */
async function testAnthropicConnection(config: ProviderTestConfig): Promise<TestResult> {
  const url = new URL(`${config.baseUrl}/v1/messages`);

  const body = JSON.stringify({
    model: config.model,
    max_tokens: 10,
    messages: [{ role: 'user', content: "Say 'ok' and nothing else" }],
  });

  return makeRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body,
  });
}

/**
 * Test OpenAI-compatible connection using chat/completions.
 */
async function testOpenAICompatibleConnection(config: ProviderTestConfig): Promise<TestResult> {
  const url = new URL(`${config.baseUrl}/chat/completions`);

  const body = JSON.stringify({
    model: config.model,
    max_tokens: 10,
    messages: [{ role: 'user', content: "Say 'ok' and nothing else" }],
  });

  return makeRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey ?? ''}`,
    },
    body,
  });
}

/**
 * Low-level HTTPS/HTTP request with 10 second timeout.
 */
function makeRequest(
  url: URL,
  opts: { method: string; headers: Record<string, string>; body: string },
): Promise<TestResult> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = transport.request(url, {
      method: opts.method,
      headers: opts.headers,
      timeout: 10_000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          let errorMsg = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            const msg = parsed.error?.message ?? parsed.error?.type ?? parsed.message ?? parsed.detail ?? parsed.title ?? '';
            if (msg) errorMsg += `: ${msg}`;
          } catch { /* ignore parse errors */ }
          resolve({ ok: false, error: errorMsg });
        }
      });
    });

    req.on('error', (e: Error) => {
      resolve({ ok: false, error: `Connection failed: ${e.message}` });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timed out after 10 seconds' });
    });

    req.write(opts.body);
    req.end();
  });
}

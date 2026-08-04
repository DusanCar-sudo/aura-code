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
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

/**
 * Normalize a user-entered base URL: trim whitespace, drop trailing slashes,
 * and strip a pasted endpoint path (/chat/completions, /completions,
 * /v1/messages) — users often paste the full endpoint URL from provider docs,
 * which would otherwise produce e.g. .../chat/completions/chat/completions.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/, '');
  url = url.replace(/\/v1\/messages$/, '/v1');
  url = url.replace(/\/+$/, '');
  return url;
}

/**
 * Strip routing/vendor prefixes that Aura adds to model IDs for internal
 * routing (e.g. "opencode/big-pickle" → "big-pickle", "ollama/llama3.2" → "llama3.2").
 * These prefixes must not be forwarded to the actual API.
 *
 * NOT applied to Custom endpoints — there the model ID is the user's exact
 * string and any prefix may be genuinely part of the remote model name
 * (e.g. OpenRouter's "qwen/qwen3-coder:free").
 */
function stripModelPrefix(model: string): string {
  // opencode/ or zen/ prefix (OpenCode Zen gateway)
  if (/^(opencode|zen)\//.test(model)) return model.replace(/^(opencode|zen)\//, '');
  // zhipu/ or zhipu-coding/ prefix (Zhipu Z.ai — endpoint routing only)
  if (/^zhipu(-coding)?\//.test(model)) return model.replace(/^zhipu(-coding)?\//, '');
  // openrouter/vendor/model  → just model (last segment)
  if (model.startsWith('openrouter/')) {
    const parts = model.split('/');
    return parts.slice(2).join('/') || model;
  }
  // ollama/model, local/model, lmstudio/model
  if (/^(ollama|local|lmstudio)\//.test(model)) return model.replace(/^[^/]+\//, '');
  // xai/model
  if (model.startsWith('xai/')) return model.replace('xai/', '');
  // xiaomi/model, mimo/model (factory accepts both prefixes)
  if (/^(xiaomi|mimo)\//.test(model)) return model.replace(/^(xiaomi|mimo)\//, '');
  return model;
}

/**
 * Test a provider connection by sending a minimal chat completion request.
 * Times out after 10 seconds.
 */
export async function testProviderConnection(config: ProviderTestConfig): Promise<TestResult> {
  const isOllama = config.provider === 'Ollama (local, free)';
  const isAnthropic = config.provider === 'Anthropic (Claude)';
  const isGoogle = config.provider === 'Google (Gemini)';
  const isCustom = config.provider === 'Custom endpoint';

  const normalized: ProviderTestConfig = { ...config, baseUrl: normalizeBaseUrl(config.baseUrl) };

  // ── Ollama: just check if the server is reachable ──────────────────────────
  if (isOllama) {
    return testOllamaConnection(normalized.baseUrl);
  }

  // ── Google: uses a different API format ────────────────────────────────────
  if (isGoogle) {
    return testGoogleConnection(normalized);
  }

  // ── Anthropic: uses x-api-key header and different body format ─────────────
  if (isAnthropic) {
    return testAnthropicConnection(normalized);
  }

  // ── All others: OpenAI-compatible chat/completions ─────────────────────────
  // Custom endpoints send the model ID verbatim — no prefix stripping.
  return testOpenAICompatibleConnection(normalized, { stripPrefix: !isCustom });
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
  const url = new URL(`${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: "Say 'ok' and nothing else" }] }],
    generationConfig: { maxOutputTokens: 64 },
  });
  return makeRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    expectField: 'candidates',
  });
}

/**
 * Test Anthropic connection using their Messages API.
 */
async function testAnthropicConnection(config: ProviderTestConfig): Promise<TestResult> {
  const url = new URL(`${config.baseUrl}/v1/messages`);
  const body = JSON.stringify({
    model: stripModelPrefix(config.model),
    max_tokens: 64,
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
    expectField: 'content',
  });
}

/**
 * Test OpenAI-compatible connection using chat/completions.
 */
async function testOpenAICompatibleConnection(
  config: ProviderTestConfig,
  opts: { stripPrefix: boolean } = { stripPrefix: true },
): Promise<TestResult> {
  const url = new URL(`${config.baseUrl}/chat/completions`);
  const body = JSON.stringify({
    model: opts.stripPrefix ? stripModelPrefix(config.model) : config.model,
    // 64 tokens: reasoning models (GLM, MiMo Pro, o-series) burn small budgets
    // on hidden thinking; 10 used to come back as an empty "length" response.
    max_tokens: 64,
    messages: [{ role: 'user', content: "Say 'ok' and nothing else" }],
  });
  return makeRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey ?? ''}`,
    },
    body,
    expectField: 'choices',
  });
}

/**
 * Low-level HTTPS/HTTP request with 10 second timeout.
 */
function makeRequest(
  url: URL,
  opts: { method: string; headers: Record<string, string>; body: string; expectField?: string },
): Promise<TestResult> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = transport.request(url, {
      method: opts.method,
      headers: {
        // Some provider edges (e.g. Z.ai's CDN) silently drop requests with
        // no User-Agent — the connection hangs until timeout instead of 401.
        'User-Agent': 'aura-code',
        'Accept': '*/*',
        'Content-Length': Buffer.byteLength(opts.body),
        ...opts.headers,
      },
      timeout: 10_000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          // 2xx alone is not proof: a wrong base URL can hit a web app that
          // answers 200 with an HTML page, or a gateway that wraps errors in
          // 200s. Require a JSON body with the field a real completion has.
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(data); } catch { /* not JSON */ }
          if (parsed === null) {
            resolve({
              ok: false,
              error: `Endpoint answered HTTP ${res.statusCode} but not with JSON (got ${data.trimStart().startsWith('<') ? 'an HTML page' : 'unparseable data'}) — the base URL probably points at a website, not an API. Check that it ends with the API root (e.g. /v1).`,
            });
            return;
          }
          if (opts.expectField && !(opts.expectField in parsed)) {
            const errMsg = (parsed as { error?: { message?: string }; msg?: string }).error?.message
              ?? (parsed as { msg?: string }).msg;
            resolve({
              ok: false,
              error: `Endpoint answered HTTP ${res.statusCode} but the response has no "${opts.expectField}" field${errMsg ? ` (server said: ${errMsg})` : ''} — wrong API format or base URL path.`,
            });
            return;
          }
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

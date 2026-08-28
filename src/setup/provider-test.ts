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
import { stripRoutingPrefix } from '../providers/factory.js';

export interface ProviderTestConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * Why a connection test failed — the wizard offers a different remedy for each.
 *
 * The distinction matters: a 429 quota error, a 401 "insufficient balance", and
 * a 500 from a dead gateway model all used to surface as one generic
 * "Connection failed", whose only offered fix was "re-enter your API key".
 * Re-typing a perfectly good key cannot fix any of them, which is exactly how
 * a working key reads as a permanently rejected one.
 */
export type TestFailureKind =
  | 'auth'      // the key itself is wrong, missing, or revoked
  | 'billing'   // the key authenticated; the account is out of credit/quota
  | 'rate'      // authenticated, momentarily rate-limited
  | 'model'     // key and endpoint fine; this model id is unavailable
  | 'server'    // the provider's own 5xx
  | 'network';  // never reached the provider

export interface TestResult {
  ok: boolean;
  error?: string;
  /** Present whenever `ok` is false. */
  kind?: TestFailureKind;
  /** HTTP status, when one was received. */
  status?: number;
}

/** Wording providers use when the key is valid but the account cannot pay. */
const BILLING_RE = /insufficient|balance|quota|credit|billing|payment|expired|exceeded your current/i;
/** Wording that points at the model id rather than the credentials. */
const MODEL_RE = /model|deployment|not found|unavailable|does not exist|unsupported/i;

/**
 * Map an HTTP status plus the provider's own message onto a remedy.
 * The message is consulted first for 401/403 and 429, because providers
 * overload those statuses for billing state (OpenCode Zen answers 401
 * "Insufficient balance"; OpenAI answers 429 "exceeded your current quota").
 */
export function classifyFailure(status: number, message: string): TestFailureKind {
  if (status === 401 || status === 403) {
    return BILLING_RE.test(message) ? 'billing' : 'auth';
  }
  if (status === 429) {
    return BILLING_RE.test(message) ? 'billing' : 'rate';
  }
  if (status === 404) return 'model';
  if (status === 400 || status === 422) {
    return MODEL_RE.test(message) ? 'model' : 'auth';
  }
  if (status >= 500) return 'server';
  return 'auth';
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
  // openrouter/vendor/model → vendor/model (the vendor segment is part of the
  // remote id there, so this one can't go through the shared stripper).
  if (model.startsWith('openrouter/')) {
    const parts = model.split('/');
    return parts.slice(2).join('/') || model;
  }
  // Everything else shares the factory's prefix list, so a prefix added for
  // routing (go-anthropic/, byteplus/, fpt/, …) can never again be routable
  // but untestable — which is how OpenCode Go's ids reached the wire intact.
  return stripRoutingPrefix(model);
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
        resolve({ ok: false, error: `Ollama responded with HTTP ${res.statusCode}`, status: res.statusCode, kind: 'server' });
      }
      res.resume();
    });
    req.on('error', (e: Error) => {
      resolve({
        ok: false,
        error: `Ollama doesn't seem to be running. Start it first: ollama serve (${e.message})`,
        kind: 'network',
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timed out after 10 seconds', kind: 'network' });
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
              status: res.statusCode,
              kind: 'network',
            });
            return;
          }
          if (opts.expectField && !(opts.expectField in parsed)) {
            const errMsg = (parsed as { error?: { message?: string }; msg?: string }).error?.message
              ?? (parsed as { msg?: string }).msg;
            resolve({
              ok: false,
              error: `Endpoint answered HTTP ${res.statusCode} but the response has no "${opts.expectField}" field${errMsg ? ` (server said: ${errMsg})` : ''} — wrong API format or base URL path.`,
              status: res.statusCode,
              kind: 'network',
            });
            return;
          }
          resolve({ ok: true });
        } else {
          const status = res.statusCode ?? 0;
          let msg = '';
          try {
            const parsed = JSON.parse(data);
            msg = parsed.error?.message ?? parsed.error?.type ?? parsed.message ?? parsed.detail ?? parsed.title ?? '';
          } catch { /* ignore parse errors */ }
          resolve({
            ok: false,
            error: `HTTP ${status}${msg ? `: ${msg}` : ''}`,
            status,
            kind: classifyFailure(status, msg),
          });
        }
      });
    });
    req.on('error', (e: Error) => {
      resolve({ ok: false, error: `Connection failed: ${e.message}`, kind: 'network' });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timed out after 10 seconds', kind: 'network' });
    });
    req.write(opts.body);
    req.end();
  });
}

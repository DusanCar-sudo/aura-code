import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Request — generic HTTP client for API calls
// ─────────────────────────────────────────────────────────────────────────────

export interface HttpRequestInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  max_chars?: number;
  timeout_ms?: number;
}

export const HTTP_REQUEST_DEFINITION: ToolDefinition = {
  name: 'http_request',
  description:
    'Make an arbitrary HTTP request to any API. Supports JSON bodies, custom headers, all HTTP methods. ' +
    'Use for calling REST APIs, webhooks, microservices. Returns status, headers, and body.',
  parameters: {
    type: 'object',
    properties: {
      url:         { type: 'string', description: 'The URL to call' },
      method:      { type: 'string', description: 'HTTP method (default: GET)' },
      headers:     { type: 'object', description: 'Request headers as key-value string pairs' },
      body:        { type: 'string', description: 'Raw request body (string)' },
      json:        { type: 'object', description: 'JSON body (auto-sets Content-Type to application/json)' },
      max_chars:   { type: 'number', description: 'Max response chars to return (default: 50000)' },
      timeout_ms:  { type: 'number', description: 'Request timeout in ms (default: 30000)' },
    },
    required: ['url'],
  },
};

export async function httpRequest(input: HttpRequestInput): Promise<string> {
  const method = (input.method ?? 'GET').toUpperCase();
  const maxChars = input.max_chars ?? 50_000;
  const timeoutMs = input.timeout_ms ?? 30_000;

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return `Error: Invalid URL: ${input.url}`;
  }

  const headers: Record<string, string> = {
    'User-Agent': 'Aura/0.2.4',
    ...input.headers,
  };

  let body: string | undefined = input.body;

  if (input.json !== undefined) {
    body = JSON.stringify(input.json);
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  if (body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(input.url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const status = response.status;
    const statusText = response.statusText;
    const contentType = response.headers.get('content-type') ?? '';

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch (e) {
      return `Error reading response: ${String(e)}`;
    }

    // Pretty-print JSON
    if (contentType.includes('json')) {
      try {
        const parsed = JSON.parse(responseBody);
        responseBody = JSON.stringify(parsed, null, 2);
      } catch { /* leave as-is */ }
    }

    const truncated = responseBody.length > maxChars
      ? responseBody.slice(0, maxChars) + `\n\n... [${responseBody.length} chars total, showing first ${maxChars}]`
      : responseBody;

    return [
      `HTTP ${status} ${statusText}`,
      `Content-Type: ${contentType}`,
      `URL: ${input.url}`,
      '',
      truncated,
    ].join('\n');
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return `Error: Request timed out after ${timeoutMs}ms`;
    }
    return `Error: ${e?.message ?? String(e)}`;
  }
}

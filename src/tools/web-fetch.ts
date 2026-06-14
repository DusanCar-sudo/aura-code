import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Web Fetch — retrieves content from any URL
// ─────────────────────────────────────────────────────────────────────────────

export interface WebFetchInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  max_chars?: number;
  timeout_ms?: number;
}

export const WEB_FETCH_DEFINITION: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch content from a URL. Returns the response body as text. ' +
    'Supports GET/POST/PUT/DELETE/PATCH/HEAD. Useful for reading web pages, ' +
    'calling APIs, downloading files. Large responses are truncated.',
  parameters: {
    type: 'object',
    properties: {
      url:         { type: 'string', description: 'The URL to fetch' },
      method:      { type: 'string', description: 'HTTP method (default: GET)' },
      headers:     { type: 'object', description: 'Request headers as key-value pairs', additionalProperties: { type: 'string' } },
      body:        { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      max_chars:   { type: 'number', description: 'Max characters to return (default: 50000)' },
      timeout_ms:  { type: 'number', description: 'Request timeout in ms (default: 15000)' },
    },
    required: ['url'],
  },
};

const MAX_CHARS_DEFAULT = 50_000;
const TIMEOUT_MS_DEFAULT = 15_000;
const MAX_REDIRECTS = 5;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated — ${text.length} chars total, showing first ${max}]`;
}

function stripHtml(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  // Decode common entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export async function webFetch(input: WebFetchInput): Promise<string> {
  const url = input.url;
  const method = (input.method ?? 'GET').toUpperCase();
  const maxChars = input.max_chars ?? MAX_CHARS_DEFAULT;
  const timeoutMs = input.timeout_ms ?? TIMEOUT_MS_DEFAULT;

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: Invalid URL: ${url}`;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return `Error: Unsupported protocol: ${parsed.protocol} (only http/https supported)`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Aura/0.2.4 (AI Agent)',
      'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
      ...input.headers,
    };

    if (input.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: input.body,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timer);

    const status = response.status;
    const statusText = response.statusText;
    const contentType = response.headers.get('content-type') ?? '';
    const contentLength = response.headers.get('content-length');

    let body: string;
    try {
      body = await response.text();
    } catch (e) {
      return `Error reading response body: ${String(e)}`;
    }

    // Build header summary
    const headerLines: string[] = [
      `HTTP ${status} ${statusText}`,
      `Content-Type: ${contentType}`,
    ];
    if (contentLength) {
      headerLines.push(`Content-Length: ${contentLength}`);
    }
    headerLines.push(`URL: ${url}`);
    headerLines.push('');

    const headerBlock = headerLines.join('\n');

    if (!response.ok) {
      return `${headerBlock}Error: HTTP ${status} ${statusText}\n\n${truncate(body, maxChars)}`;
    }

    // Auto-detect and clean HTML
    const isHtml = contentType.includes('html');
    const isJson = contentType.includes('json');

    let processed = body;
    if (isHtml) {
      processed = stripHtml(body);
    }

    // For JSON, try to pretty-print
    if (isJson) {
      try {
        const parsed = JSON.parse(processed);
        processed = JSON.stringify(parsed, null, 2);
      } catch {
        // leave as-is if parse fails
      }
    }

    return `${headerBlock}${truncate(processed, maxChars)}`;
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      return `Error: Request timed out after ${timeoutMs}ms — ${url}`;
    }
    return `Error fetching ${url}: ${String(e?.message ?? e)}`;
  }
}

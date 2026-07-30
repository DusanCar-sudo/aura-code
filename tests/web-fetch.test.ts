import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dns from 'dns';
import { webFetch, WEB_FETCH_DEFINITION } from '../src/tools/web-fetch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock global fetch
// ─────────────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  // The SSRF guard resolves DNS before fetching; these tests use non-routable
  // example hostnames, so stub resolution to a public IP. SSRF *blocking* is
  // covered hermetically by ssrf.test.ts using IP literals.
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(body: string, init?: ResponseInit & { contentType?: string }) {
  const headers = new Headers(init?.headers as Record<string, string> ?? {});
  if (init?.contentType) headers.set('content-type', init.contentType);
  return new Response(body, { ...init, headers });
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

describe('WEB_FETCH_DEFINITION', () => {
  it('has correct name', () => {
    expect(WEB_FETCH_DEFINITION.name).toBe('web_fetch');
  });

  it('requires url parameter', () => {
    expect(WEB_FETCH_DEFINITION.parameters.required).toEqual(['url']);
  });

  it('has all expected properties', () => {
    const props = Object.keys(WEB_FETCH_DEFINITION.parameters.properties);
    expect(props).toContain('url');
    expect(props).toContain('method');
    expect(props).toContain('headers');
    expect(props).toContain('body');
    expect(props).toContain('max_chars');
    expect(props).toContain('timeout_ms');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// URL validation
// ─────────────────────────────────────────────────────────────────────────────

describe('webFetch — URL validation', () => {
  it('rejects invalid URL', async () => {
    const result = await webFetch({ url: 'not-a-url' });
    expect(result).toContain('Error: Invalid URL');
  });

  it('rejects unsupported protocol (ftp)', async () => {
    const result = await webFetch({ url: 'ftp://example.com/file' });
    expect(result).toContain('Error: Unsupported protocol');
  });

  it('accepts http URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'http://example.com' });
    expect(result).toContain('HTTP 200');
  });

  it('accepts https URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).toContain('HTTP 200');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic fetching
// ─────────────────────────────────────────────────────────────────────────────

describe('webFetch — basic fetching', () => {
  it('returns response body on success', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Hello, world!', { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).toContain('Hello, world!');
    expect(result).toContain('HTTP 200');
  });

  it('includes URL in output', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com/page' });
    expect(result).toContain('https://example.com/page');
  });

  it('includes content-type header', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('data', { contentType: 'application/json' }));
    const result = await webFetch({ url: 'https://api.example.com' });
    expect(result).toContain('application/json');
  });

  it('uses GET method by default', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { contentType: 'text/plain' }));
    await webFetch({ url: 'https://example.com' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses custom method when specified', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { contentType: 'text/plain' }));
    await webFetch({ url: 'https://example.com', method: 'POST' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('passes custom headers', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { contentType: 'text/plain' }));
    await webFetch({ url: 'https://example.com', headers: { Authorization: 'Bearer token' } });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    );
  });

  it('passes body for POST request', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('{"id":1}', { contentType: 'application/json' }));
    await webFetch({ url: 'https://api.example.com', method: 'POST', body: '{"name":"test"}' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com',
      expect.objectContaining({ body: '{"name":"test"}' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML stripping
// ─────────────────────────────────────────────────────────────────────────────

describe('webFetch — HTML stripping', () => {
  it('strips HTML tags from HTML responses', async () => {
    const html = '<html><body><h1>Title</h1><p>Paragraph text</p></body></html>';
    mockFetch.mockResolvedValueOnce(mockResponse(html, { contentType: 'text/html' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).toContain('Title');
    expect(result).toContain('Paragraph text');
    expect(result).not.toContain('<h1>');
    expect(result).not.toContain('<p>');
  });

  it('removes script tags', async () => {
    const html = '<html><script>alert("xss")</script><p>Safe</p></html>';
    mockFetch.mockResolvedValueOnce(mockResponse(html, { contentType: 'text/html' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).not.toContain('alert');
    expect(result).toContain('Safe');
  });

  it('decodes HTML entities', async () => {
    const html = '<p>Tom &amp; Jerry &lt;3</p>';
    mockFetch.mockResolvedValueOnce(mockResponse(html, { contentType: 'text/html' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).toContain('Tom & Jerry');
    expect(result).toContain('<3');
  });

  it('does not strip non-HTML responses', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('plain text <no tags>', { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).toContain('<no tags>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON handling
// ─────────────────────────────────────────────────────────────────────────────

describe('webFetch — JSON handling', () => {
  it('pretty-prints JSON responses', async () => {
    const json = '{"name":"test","nested":{"key":"value"}}';
    mockFetch.mockResolvedValueOnce(mockResponse(json, { contentType: 'application/json' }));
    const result = await webFetch({ url: 'https://api.example.com' });
    expect(result).toContain('  "name": "test"');
    expect(result).toContain('  "nested"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('webFetch — error handling', () => {
  it('returns error on HTTP 404', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Not Found', { status: 404, statusText: 'Not Found', contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com/missing' });
    expect(result).toContain('HTTP 404');
    expect(result).toContain('Not Found');
  });

  it('returns error on HTTP 500', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Internal Server Error', { status: 500, statusText: 'Internal Server Error', contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).toContain('HTTP 500');
  });

  it('handles network errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await webFetch({ url: 'https://unreachable.example.com' });
    expect(result).toContain('Error fetching');
  });

  it('handles timeout', async () => {
    mockFetch.mockImplementationOnce((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }
      });
    });
    const result = await webFetch({ url: 'https://slow.example.com', timeout_ms: 50 });
    expect(result).toContain('timed out');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncation
// ─────────────────────────────────────────────────────────────────────────────

describe('webFetch — truncation', () => {
  it('truncates large responses', async () => {
    const bigBody = 'x'.repeat(100_000);
    mockFetch.mockResolvedValueOnce(mockResponse(bigBody, { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com', max_chars: 1000 });
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(bigBody.length);
  });

  it('does not truncate small responses', async () => {
    const smallBody = 'hello';
    mockFetch.mockResolvedValueOnce(mockResponse(smallBody, { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com' });
    expect(result).not.toContain('truncated');
    expect(result).toContain('hello');
  });

  it('respects custom max_chars', async () => {
    const body = 'a'.repeat(500);
    mockFetch.mockResolvedValueOnce(mockResponse(body, { contentType: 'text/plain' }));
    const result = await webFetch({ url: 'https://example.com', max_chars: 100 });
    expect(result).toContain('truncated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA-fallback detection
//
// Static hosts answer every unmatched path with index.html and HTTP 200, never a
// 404. A request for /style.css therefore "succeeds", and after stripHtml() the
// body reads as ordinary prose with nothing marking it as the wrong file. That
// is what stalled a real run: five fetches (/style.css, /index.css, / at two
// different max_chars, / with explicit headers) all returned byte-identical
// HTML, and the agent kept guessing new paths against a host that answers 200 to
// all of them.
// ─────────────────────────────────────────────────────────────────────────────

describe('web_fetch asset/content-type mismatch', () => {
  const spaHtml = '<html><body><h1>Landing page</h1><p>Welcome</p></body></html>';

  it('warns when a .css request returns HTML', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(spaHtml, { contentType: 'text/html; charset=utf-8' }));
    const result = await webFetch({ url: 'https://example.com/style.css' });
    expect(result).toContain('WARNING: requested .css');
    expect(result).toContain('index.html');
    expect(result).toContain('do not guess further variants');
  });

  it('warns for the other asset extensions too', async () => {
    for (const ext of ['js', 'mjs', 'json', 'xml', 'svg']) {
      mockFetch.mockResolvedValueOnce(mockResponse(spaHtml, { contentType: 'text/html' }));
      const result = await webFetch({ url: `https://example.com/app.${ext}` });
      expect(result, ext).toContain(`WARNING: requested .${ext}`);
    }
  });

  it('stays silent when the asset arrives with the right type', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('body{color:red}', { contentType: 'text/css' }));
    const result = await webFetch({ url: 'https://example.com/style.css' });
    expect(result).not.toContain('WARNING');
    expect(result).toContain('body{color:red}');
  });

  it('stays silent for JSON served as JSON', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('{"a":1}', { contentType: 'application/json' }));
    const result = await webFetch({ url: 'https://example.com/data.json' });
    expect(result).not.toContain('WARNING');
  });

  it('stays silent on an extensionless URL that returns HTML', async () => {
    // The normal case — asking for a page and getting a page.
    mockFetch.mockResolvedValueOnce(mockResponse(spaHtml, { contentType: 'text/html' }));
    const result = await webFetch({ url: 'https://example.com/' });
    expect(result).not.toContain('WARNING');
  });

  it('stays silent when a non-HTML type comes back for an asset', async () => {
    // Wrong type but not the SPA-fallback signature; no claim to make.
    mockFetch.mockResolvedValueOnce(mockResponse('x', { contentType: 'application/octet-stream' }));
    const result = await webFetch({ url: 'https://example.com/style.css' });
    expect(result).not.toContain('WARNING');
  });

  it('puts the warning above the body, not buried after it', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(spaHtml, { contentType: 'text/html' }));
    const result = await webFetch({ url: 'https://example.com/style.css' });
    expect(result.indexOf('WARNING')).toBeLessThan(result.indexOf('Landing page'));
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpRequest, HTTP_REQUEST_DEFINITION } from '../src/tools/http-request.js';

const mockFetch = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockResponse(body: string, init?: ResponseInit & { contentType?: string }) {
  const headers = new Headers(init?.headers as Record<string, string> ?? {});
  if (init?.contentType) headers.set('content-type', init.contentType);
  return new Response(body, { ...init, headers });
}

describe('HTTP_REQUEST_DEFINITION', () => {
  it('has correct name', () => expect(HTTP_REQUEST_DEFINITION.name).toBe('http_request'));
  it('requires url', () => expect(HTTP_REQUEST_DEFINITION.parameters.required).toEqual(['url']));
});

describe('httpRequest — validation', () => {
  it('rejects invalid URL', async () => {
    const r = await httpRequest({ url: 'not-a-url' });
    expect(r).toContain('Error: Invalid URL');
  });
});

describe('httpRequest — basic', () => {
  it('makes GET request and returns response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('{"ok":true}', { status: 200, contentType: 'application/json' }));
    const r = await httpRequest({ url: 'https://api.test.com/data' });
    expect(r).toContain('HTTP 200');
    expect(r).toContain('"ok": true');
  });

  it('uses custom method', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('done', { status: 201, contentType: 'text/plain' }));
    await httpRequest({ url: 'https://api.test.com', method: 'POST' });
    expect(mockFetch).toHaveBeenCalledWith('https://api.test.com', expect.objectContaining({ method: 'POST' }));
  });

  it('sends JSON body', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('ok', { status: 200, contentType: 'text/plain' }));
    await httpRequest({ url: 'https://api.test.com', json: { name: 'test' } });
    expect(mockFetch).toHaveBeenCalledWith('https://api.test.com', expect.objectContaining({ body: '{"name":"test"}' }));
  });

  it('handles HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', { status: 401, statusText: 'Unauthorized', contentType: 'text/plain' }));
    const r = await httpRequest({ url: 'https://api.test.com' });
    expect(r).toContain('HTTP 401');
  });

  it('handles network errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const r = await httpRequest({ url: 'https://unreachable.test.com' });
    expect(r).toContain('Error');
  });
});

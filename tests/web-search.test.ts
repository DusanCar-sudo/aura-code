import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearch, WEB_SEARCH_DEFINITION } from '../src/tools/web-search.js';

const mockFetch = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockResponse(body: string, init?: ResponseInit) {
  return new Response(body, init);
}

describe('WEB_SEARCH_DEFINITION', () => {
  it('has correct name', () => expect(WEB_SEARCH_DEFINITION.name).toBe('web_search'));
  it('requires query', () => expect(WEB_SEARCH_DEFINITION.parameters.required).toEqual(['query']));
});

describe('webSearch — validation', () => {
  it('returns error for empty query', async () => {
    const r = await webSearch({ query: '' });
    expect(r).toContain('Error: query');
  });
});

describe('webSearch — results', () => {
  it('parses results from DuckDuckGo HTML', async () => {
    const html = `
      <a class="result__a" href="https://example.com/redirect?uddg=https%3A%2F%2Freal.com">Test Title</a>
      <a class="result__snippet">A snippet about the result</a>
    `;
    mockFetch.mockResolvedValueOnce(mockResponse(html, { status: 200 }));
    const r = await webSearch({ query: 'test' });
    expect(r).toContain('Test Title');
    expect(r).toContain('real.com');
    expect(r).toContain('snippet');
  });

  it('returns no results message when empty', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('<html></html>', { status: 200 }));
    const r = await webSearch({ query: 'xyznonexistent' });
    expect(r).toContain('No results found');
  });

  it('handles HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('', { status: 503 }));
    const r = await webSearch({ query: 'test' });
    expect(r).toContain('Error');
  });
});

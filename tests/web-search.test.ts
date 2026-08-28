import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearch, WEB_SEARCH_DEFINITION } from '../src/tools/web-search.js';

const mockFetch = vi.fn();
const savedEnv = { ...process.env };
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

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

/**
 * The regression these cover: DuckDuckGo began answering with an HTTP 202
 * bot-check page, and the old code reported that as `No results found` — a
 * string an agent cannot distinguish from a genuinely empty result set. The
 * observed consequence was a search-degradation spiral ("AI inference" →
 * "machine learning" → "linux" → "hello world") and a run that built nothing.
 * A dead backend must read as an error, and an empty result must not.
 */
describe('webSearch — backend unavailable vs genuinely empty', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => { delete process.env.BRAVE_API_KEY; delete process.env.TAVILY_API_KEY; });
  afterEach(() => { process.env = { ...savedEnv }; });

  it('reports a DuckDuckGo 202 bot-check as an error, not as an empty result', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('<html><title>DuckDuckGo</title></html>', { status: 202 }));
    const r = await webSearch({ query: 'AI inference' });
    expect(r).toContain('Error: web_search is unavailable');
    expect(r).toContain('bot-check');
    expect(r).not.toContain('No results found');
  });

  it('detects a 200 challenge page that carries no results', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('<html>anomaly detected, please solve this challenge</html>', { status: 200 }));
    const r = await webSearch({ query: 'test' });
    expect(r).toContain('Error: web_search is unavailable');
  });

  it('tells the caller not to retry with simpler wording', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('', { status: 202 }));
    const r = await webSearch({ query: 'test' });
    expect(r).toMatch(/Do NOT retry this search with different or simpler wording/);
    expect(r).toContain('BRAVE_API_KEY');
  });

  it('still reports a real empty result set as empty, and says which backend answered', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('<html><body>no matches</body></html>', { status: 200 }));
    const r = await webSearch({ query: 'zzzznonexistent' });
    expect(r).toContain('No results found');
    expect(r).toContain('the backend worked');
  });
});

describe('webSearch — keyed backends', () => {
  const savedEnv = { ...process.env };
  afterEach(() => { process.env = { ...savedEnv }; });

  it('uses Brave when a key is set, and never touches DuckDuckGo', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    delete process.env.TAVILY_API_KEY;
    mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify({
      web: { results: [{ title: 'Swiss Grid', url: 'https://example.com/g', description: 'On grids' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const r = await webSearch({ query: 'swiss grid' });
    expect(r).toContain('via Brave');
    expect(r).toContain('Swiss Grid');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('api.search.brave.com');
  });

  it('falls through to the next backend when Brave rejects the key', async () => {
    process.env.BRAVE_API_KEY = 'bad-key';
    delete process.env.TAVILY_API_KEY;
    mockFetch
      .mockResolvedValueOnce(mockResponse('', { status: 401 }))
      .mockResolvedValueOnce(mockResponse(
        '<a class="result__a" href="https://x.com">T</a><a class="result__snippet">S</a>',
        { status: 200 },
      ));
    const r = await webSearch({ query: 'q' });
    expect(r).toContain('via DuckDuckGo');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses Tavily when only that key is set', async () => {
    delete process.env.BRAVE_API_KEY;
    process.env.TAVILY_API_KEY = 'tv-key';
    mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify({
      results: [{ title: 'R', url: 'https://t.example', content: 'body' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await webSearch({ query: 'q' });
    expect(r).toContain('via Tavily');
    expect(String(mockFetch.mock.calls[0][0])).toContain('api.tavily.com');
  });

  it('lists every backend failure when all of them fail', async () => {
    process.env.BRAVE_API_KEY = 'k';
    delete process.env.TAVILY_API_KEY;
    mockFetch
      .mockResolvedValueOnce(mockResponse('', { status: 429 }))
      .mockResolvedValueOnce(mockResponse('', { status: 202 }));
    const r = await webSearch({ query: 'q' });
    expect(r).toContain('Brave API rate limit');
    expect(r).toContain('bot-check');
  });
});

describe('probeSearchAvailability', () => {
  const savedEnv = { ...process.env };
  afterEach(() => { process.env = { ...savedEnv }; });

  it('trusts a configured key without spending a request on it', async () => {
    process.env.BRAVE_API_KEY = 'k';
    const { probeSearchAvailability } = await import('../src/tools/web-search.js');
    const r = await probeSearchAvailability();
    expect(r).toEqual({ available: true, backend: 'Brave' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('probes DuckDuckGo when unkeyed and reports it blocked', async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;
    mockFetch.mockResolvedValueOnce(mockResponse('', { status: 202 }));
    const { probeSearchAvailability } = await import('../src/tools/web-search.js');
    const r = await probeSearchAvailability();
    expect(r.available).toBe(false);
    expect(r.reason).toContain('bot-check');
  });
});

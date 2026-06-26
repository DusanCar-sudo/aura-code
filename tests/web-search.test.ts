import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearch, WEB_SEARCH_DEFINITION } from '../src/tools/web-search.js';

const mockFetch = vi.fn();

// Each test starts with both API keys cleared and `fetch` stubbed. Tests
// that exercise the Tavily or Serper path set their own key, then queue
// the appropriate mock responses. Tests that want the DuckDuckGo fallback
// leave both keys unset so the Tavily/Serper branches return null and
// the chain falls straight through to the DDG scrape.
const savedEnv: { TAVILY?: string; SERPER?: string } = {};

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  savedEnv.TAVILY = process.env.TAVILY_API_KEY;
  savedEnv.SERPER = process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedEnv.TAVILY !== undefined) process.env.TAVILY_API_KEY = savedEnv.TAVILY;
  if (savedEnv.SERPER !== undefined) process.env.SERPER_API_KEY = savedEnv.SERPER;
});

function mockResponse(body: string, init?: ResponseInit) {
  return new Response(body, init);
}

function mockJson(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
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

  it('returns error for whitespace-only query', async () => {
    const r = await webSearch({ query: '   ' });
    expect(r).toContain('Error: query');
  });
});

describe('webSearch — Tavily (primary)', () => {
  it('uses Tavily when key is set and returns formatted results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockFetch.mockResolvedValueOnce(mockJson({
      results: [
        { title: 'Tavily Hit', url: 'https://tavily-result.com', content: 'snippet from tavily' },
      ],
    }));

    const r = await webSearch({ query: 'test' });
    expect(r).toContain('via Tavily');
    expect(r).toContain('Tavily Hit');
    expect(r).toContain('tavily-result.com');
    expect(r).toContain('snippet from tavily');
  });

  it('sends the query to the Tavily API endpoint', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockFetch.mockResolvedValueOnce(mockJson({ results: [{ title: 'x', url: 'https://x.com', content: '' }] }));

    await webSearch({ query: 'hello world' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(String(calledUrl)).toContain('tavily.com');
    expect(calledInit).toBeDefined();
    expect(JSON.parse(calledInit.body as string).query).toBe('hello world');
  });

  it('falls through to next provider when Tavily returns HTTP error', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    process.env.SERPER_API_KEY = 'serper-test-key';
    // Tavily 500
    mockFetch.mockResolvedValueOnce(mockResponse('boom', { status: 500 }));
    // Serper succeeds
    mockFetch.mockResolvedValueOnce(mockJson({
      organic: [{ title: 'Fallback', link: 'https://fallback.com', snippet: 'ok' }],
    }));

    const r = await webSearch({ query: 'test' });
    expect(r).toContain('via Serper');
    expect(r).toContain('Fallback');
  });

  it('falls through when Tavily returns zero results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    process.env.SERPER_API_KEY = 'serper-test-key';
    mockFetch.mockResolvedValueOnce(mockJson({ results: [] }));
    mockFetch.mockResolvedValueOnce(mockJson({
      organic: [{ title: 'Serper Hit', link: 'https://serper.com', snippet: 's' }],
    }));

    const r = await webSearch({ query: 'test' });
    expect(r).toContain('via Serper');
    expect(r).toContain('Serper Hit');
  });
});

describe('webSearch — Serper (fallback)', () => {
  it('uses Serper when only Serper key is set', async () => {
    process.env.SERPER_API_KEY = 'serper-test-key';
    mockFetch.mockResolvedValueOnce(mockJson({
      organic: [
        { title: 'Serper Result', link: 'https://serper-result.com', snippet: 'from serper' },
      ],
    }));

    const r = await webSearch({ query: 'test' });
    expect(r).toContain('via Serper');
    expect(r).toContain('Serper Result');
    expect(r).toContain('serper-result.com');
  });

  it('sends the query to the Serper API endpoint with correct header', async () => {
    process.env.SERPER_API_KEY = 'serper-test-key';
    mockFetch.mockResolvedValueOnce(mockJson({
      organic: [{ title: 'x', link: 'https://x.com', snippet: '' }],
    }));

    await webSearch({ query: 'hello' });
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(String(calledUrl)).toContain('serper.dev');
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('serper-test-key');
  });
});

describe('webSearch — DuckDuckGo (last resort)', () => {
  it('parses results from DuckDuckGo HTML when no API keys are set', async () => {
    const html = `
      <a class="result__a" href="https://example.com/redirect?uddg=https%3A%2F%2Freal.com">Test Title</a>
      <a class="result__snippet">A snippet about the result</a>
    `;
    mockFetch.mockResolvedValueOnce(mockResponse(html, { status: 200 }));
    const r = await webSearch({ query: 'test' });
    expect(r).toContain('via DuckDuckGo');
    expect(r).toContain('Test Title');
    expect(r).toContain('real.com');
    expect(r).toContain('snippet');
  });
});

describe('webSearch — all providers exhausted', () => {
  it('returns a loud error when DDG returns empty HTML and no keys are set', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('<html></html>', { status: 200 }));
    const r = await webSearch({ query: 'xyznonexistent' });
    expect(r).toContain('Error: web search unavailable');
    expect(r).toContain('xyznonexistent');
  });

  it('returns a loud error when DDG returns HTTP error and no keys are set', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('', { status: 503 }));
    const r = await webSearch({ query: 'test' });
    expect(r).toContain('Error: web search unavailable');
  });

  it('mentions all attempted providers in the loud error', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    process.env.SERPER_API_KEY = 'serper-test-key';
    // Tavily fails
    mockFetch.mockResolvedValueOnce(mockResponse('boom', { status: 500 }));
    // Serper fails
    mockFetch.mockResolvedValueOnce(mockResponse('boom', { status: 500 }));
    // DDG returns empty
    mockFetch.mockResolvedValueOnce(mockResponse('<html></html>', { status: 200 }));

    const r = await webSearch({ query: 'test' });
    expect(r).toContain('Error: web search unavailable');
    expect(r).toContain('Tavily');
    expect(r).toContain('Serper');
    expect(r).toContain('DuckDuckGo');
  });
});

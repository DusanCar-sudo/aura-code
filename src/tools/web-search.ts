import type { ToolDefinition } from '../providers/types.js';
import { stripHtml } from '../util/sanitize.js';

/**
 * Web Search — multi-provider with graceful fallback.
 *
 * Resolution order:
 *   1. Tavily   (process.env.TAVILY_API_KEY) — AI-tuned, best snippets, 1000/mo free
 *   2. Serper   (process.env.SERPER_API_KEY) — Google results passthrough, 2500/mo free
 *   3. DuckDuckGo HTML scrape — no key required, but brittle (DDG changes
 *      its markup periodically; the scraper rots).
 *
 * If ALL THREE fail, we return an explicit `Error: web search unavailable...`
 * string. This is critical — the previous implementation silently returned
 * `"No results found for: <query>"` on scraper breakage, which the calling
 * agents interpreted as a real empty result and then re-queried 15+ times
 * burning tokens (see :council Pavle / SpaceX incidents, 2026-06-26). Loud
 * errors make agents stop retrying and try a different tool (e.g. web_fetch
 * to a known URL).
 *
 * Tool interface (name, params, return shape) is unchanged from the
 * original so the agent loop and existing tests keep working.
 */

export interface WebSearchInput {
  query: string;
  max_results?: number;
  region?: string;
}

export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web. Returns ranked titles, URLs, and snippets. ' +
    'Uses Tavily or Serper if API keys are set, falling back to DuckDuckGo. ' +
    'Use for research, fact-checking, finding documentation.',
  parameters: {
    type: 'object',
    properties: {
      query:       { type: 'string', description: 'The search query' },
      max_results: { type: 'number', description: 'Max results to return (default: 10)' },
      region:      { type: 'string', description: 'Search region for DuckDuckGo (default: wt-wt for global)' },
    },
    required: ['query'],
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ── Result formatting ──────────────────────────────────────────────────────

function formatResults(query: string, results: SearchResult[], source: string): string {
  if (results.length === 0) {
    return `No results found for "${query}" (via ${source})`;
  }
  const lines: string[] = [`Search results for "${query}" (via ${source})`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  return lines.join('\n');
}

// ── Provider 1: Tavily ─────────────────────────────────────────────────────

async function searchTavily(query: string, maxResults: number): Promise<SearchResult[] | null> {
  const key = process.env.TAVILY_API_KEY;
  if (!key || !key.trim()) return null;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key.trim()}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Tavily HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? [])
    .filter(r => r.url)
    .map(r => ({
      title: (r.title ?? r.url ?? '').trim(),
      url: r.url!,
      snippet: (r.content ?? '').trim(),
    }));
}

// ── Provider 2: Serper (Google passthrough) ────────────────────────────────

async function searchSerper(query: string, maxResults: number): Promise<SearchResult[] | null> {
  const key = process.env.SERPER_API_KEY;
  if (!key || !key.trim()) return null;

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key.trim(),
    },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Serper HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = await response.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.organic ?? [])
    .filter(r => r.link)
    .slice(0, maxResults)
    .map(r => ({
      title: (r.title ?? r.link ?? '').trim(),
      url: r.link!,
      snippet: (r.snippet ?? '').trim(),
    }));
}

// ── Provider 3: DuckDuckGo HTML scrape (no key) ────────────────────────────

function extractDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultRegex.exec(html)) !== null) {
    let url = match[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = stripHtml(match[2]).trim();
    const snippet = stripHtml(match[3]).trim();
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

async function searchDuckDuckGo(query: string, maxResults: number, region: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, kl: region, t: 'h_' });
  const url = `https://html.duckduckgo.com/html/?${params}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTTP ${response.status}`);
  }

  const html = await response.text();
  return extractDuckDuckGo(html).slice(0, maxResults);
}

// ── Public entry: try each provider in order ───────────────────────────────

export async function webSearch(input: WebSearchInput): Promise<string> {
  const maxResults = input.max_results ?? 10;
  const region = input.region ?? 'wt-wt';
  const query = input.query;
  if (!query || !query.trim()) return 'Error: query is required';

  const attempts: string[] = [];

  // 1. Tavily
  try {
    const results = await searchTavily(query, maxResults);
    if (results !== null) {
      if (results.length > 0) return formatResults(query, results, 'Tavily');
      attempts.push('Tavily: 0 results');
    }
  } catch (e) {
    attempts.push(`Tavily: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Serper
  try {
    const results = await searchSerper(query, maxResults);
    if (results !== null) {
      if (results.length > 0) return formatResults(query, results, 'Serper');
      attempts.push('Serper: 0 results');
    }
  } catch (e) {
    attempts.push(`Serper: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. DuckDuckGo scrape (no key needed; always attempted last)
  try {
    const results = await searchDuckDuckGo(query, maxResults, region);
    if (results.length > 0) return formatResults(query, results, 'DuckDuckGo');
    attempts.push('DuckDuckGo: 0 results (scraper may need updating)');
  } catch (e) {
    attempts.push(`DuckDuckGo: ${e instanceof Error ? e.message : String(e)}`);
  }

  // All providers exhausted — return a LOUD error, not a silent "no results".
  // Agents see this and stop retrying the same query; they'll switch to
  // web_fetch on a known URL instead.
  return (
    `Error: web search unavailable for "${query}". ` +
    `All providers exhausted: ${attempts.join(' | ')}. ` +
    `Consider trying web_fetch on a known URL, or set TAVILY_API_KEY / SERPER_API_KEY.`
  );
}

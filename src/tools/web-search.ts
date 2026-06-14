import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Web Search — DuckDuckGo HTML search (no API key required)
// ─────────────────────────────────────────────────────────────────────────────

export interface WebSearchInput {
  query: string;
  max_results?: number;
  region?: string;
}

export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. ' +
    'No API key required. Use for research, fact-checking, finding documentation.',
  parameters: {
    type: 'object',
    properties: {
      query:        { type: 'string', description: 'The search query' },
      max_results:  { type: 'number', description: 'Max results to return (default: 10)' },
      region:       { type: 'string', description: 'Search region (default: wt-wt for global)' },
    },
    required: ['query'],
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function extractResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Match DuckDuckGo result blocks
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultRegex.exec(html)) !== null) {
    let url = match[1];
    // DuckDuckGo wraps URLs in a redirect — extract the real URL
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);

    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

export async function webSearch(input: WebSearchInput): Promise<string> {
  const maxResults = input.max_results ?? 10;
  const region = input.region ?? 'wt-wt';
  const query = input.query;

  if (!query.trim()) return 'Error: query is required';

  const params = new URLSearchParams({
    q: query,
    kl: region,
    t: 'h_',
  });

  const url = `https://html.duckduckgo.com/html/?${params}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return `Error: DuckDuckGo returned HTTP ${response.status}`;
    }

    const html = await response.text();
    const results = extractResults(html).slice(0, maxResults);

    if (results.length === 0) {
      return `No results found for: "${query}"`;
    }

    const lines: string[] = [`Search results for: "${query}"`, ''];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    });

    return lines.join('\n');
  } catch (e: any) {
    return `Error searching: ${e?.message ?? String(e)}`;
  }
}

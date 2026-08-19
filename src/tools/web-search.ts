import type { ToolDefinition } from '../providers/types.js';
import { getApiKey } from '../util/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Web Search — keyed APIs first (Brave, Tavily), DuckDuckGo HTML scrape last.
//
// This used to be DuckDuckGo-only. DDG now answers the html/ and lite/ endpoints
// with an HTTP 202 bot-check page for most datacentre and many residential IPs,
// and the old code reported that as `No results found for: "<query>"` — a string
// indistinguishable from a real empty result set. The agent, told a search
// legitimately matched nothing, does the rational thing and retries with
// broader queries: "AI inference" → "machine learning" → "linux" → "computer"
// → "hello world", burning turns and then giving up with nothing built.
//
// So two things matter here, and the second matters more than which engine wins:
//   1. Try a backend that actually works. A keyed API (Brave/Tavily free tiers)
//      is the only reliable option; the scrape stays as a no-config fallback.
//   2. NEVER let an unavailable backend look like an empty result. A blocked or
//      unconfigured search returns an explicit Error: telling the caller the
//      backend failed and how to fix it — that is a wall the agent stops at,
//      not a hint to search harder.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebSearchInput {
  query: string;
  max_results?: number;
  region?: string;
}

export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web. Uses the Brave or Tavily API when a key is configured, ' +
    'otherwise falls back to scraping DuckDuckGo (which may be rate-limited or ' +
    'blocked). Returns titles, URLs, and snippets.',
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

/** A backend either produced results, or failed for a stated reason. The
 *  distinction is the whole point of this module — see the header. */
type BackendOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: string };

const TIMEOUT_MS = 12_000;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

// ── Brave Search API ────────────────────────────────────────────────────────
// Free tier: 2,000 queries/month, no card. Key: https://brave.com/search/api/
async function braveSearch(query: string, max: number, key: string): Promise<BackendOutcome> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, max)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Brave API rejected the key (401/403)' };
    if (res.status === 429) return { ok: false, reason: 'Brave API rate limit reached (429)' };
    if (!res.ok) return { ok: false, reason: `Brave API returned HTTP ${res.status}` };

    const data = await res.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const results = (data.web?.results ?? [])
      .filter(r => r.url)
      .map(r => ({ title: strip(r.title ?? r.url!), url: r.url!, snippet: strip(r.description ?? '') }));
    return { ok: true, results };
  } catch (e: any) {
    return { ok: false, reason: `Brave API request failed: ${e?.message ?? String(e)}` };
  }
}

// ── Tavily API ──────────────────────────────────────────────────────────────
// Free tier: 1,000 credits/month. Built for agents — snippets are longer.
async function tavilySearch(query: string, max: number, key: string): Promise<BackendOutcome> {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: Math.min(20, max) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Tavily API rejected the key (401/403)' };
    if (res.status === 429) return { ok: false, reason: 'Tavily API rate limit reached (429)' };
    if (!res.ok) return { ok: false, reason: `Tavily API returned HTTP ${res.status}` };

    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (data.results ?? [])
      .filter(r => r.url)
      .map(r => ({ title: strip(r.title ?? r.url!), url: r.url!, snippet: strip(r.content ?? '') }));
    return { ok: true, results };
  } catch (e: any) {
    return { ok: false, reason: `Tavily API request failed: ${e?.message ?? String(e)}` };
  }
}

// ── DuckDuckGo HTML scrape (no key, unreliable) ─────────────────────────────
export function extractDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultRegex.exec(html)) !== null) {
    let url = match[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = strip(match[2]);
    const snippet = strip(match[3]);
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

/** Recognise DDG's bot-check page. It comes back HTTP 200 or 202 with a normal
 *  looking shell and no results, so status alone does not identify it. */
export function isDuckDuckGoChallenge(status: number, html: string): boolean {
  if (status === 202) return true;
  return /anomaly|challenge|captcha/i.test(html) && !/result__a/.test(html);
}

async function duckDuckGoSearch(query: string, region: string): Promise<BackendOutcome> {
  const params = new URLSearchParams({ q: query, kl: region, t: 'h_' });
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const html = await res.text();

    if (isDuckDuckGoChallenge(res.status, html)) {
      return { ok: false, reason: 'DuckDuckGo served a bot-check page instead of results (this IP is being blocked)' };
    }
    if (!res.ok) return { ok: false, reason: `DuckDuckGo returned HTTP ${res.status}` };

    return { ok: true, results: extractDuckDuckGoResults(html) };
  } catch (e: any) {
    return { ok: false, reason: `DuckDuckGo request failed: ${e?.message ?? String(e)}` };
  }
}

/** Which backends are available, in preference order. Exported for the doctor
 *  check and for tests. */
export function availableBackends(): Array<{ name: string; keyed: boolean }> {
  const out: Array<{ name: string; keyed: boolean }> = [];
  if (getApiKey('BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY')) out.push({ name: 'brave', keyed: true });
  if (getApiKey('TAVILY_API_KEY')) out.push({ name: 'tavily', keyed: true });
  out.push({ name: 'duckduckgo', keyed: false });
  return out;
}

const NO_BACKEND_HELP =
  'No search backend is currently working.\n' +
  'DuckDuckGo (the no-key fallback) is blocking this machine, and no search API key is set.\n' +
  'Fix: set BRAVE_API_KEY (free tier at https://brave.com/search/api/) or TAVILY_API_KEY\n' +
  '(https://tavily.com), then retry.\n' +
  'Do NOT retry this search with different or simpler wording — the query is not the problem.';

export async function webSearch(input: WebSearchInput): Promise<string> {
  const maxResults = input.max_results ?? 10;
  const region = input.region ?? 'wt-wt';
  const query = input.query;

  if (!query.trim()) return 'Error: query is required';

  const brave = getApiKey('BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY');
  const tavily = getApiKey('TAVILY_API_KEY');

  const attempts: Array<{ name: string; run: () => Promise<BackendOutcome> }> = [];
  if (brave) attempts.push({ name: 'Brave', run: () => braveSearch(query, maxResults, brave) });
  if (tavily) attempts.push({ name: 'Tavily', run: () => tavilySearch(query, maxResults, tavily) });
  attempts.push({ name: 'DuckDuckGo', run: () => duckDuckGoSearch(query, region) });

  const failures: string[] = [];

  for (const attempt of attempts) {
    const outcome = await attempt.run();
    if (!outcome.ok) {
      failures.push(`${attempt.name}: ${outcome.reason}`);
      continue;
    }

    const results = outcome.results.slice(0, maxResults);
    // A working backend that genuinely matched nothing is a real answer — report
    // it as such and stop, rather than falling through to a weaker backend.
    if (results.length === 0) {
      return `No results found for: "${query}" (searched via ${attempt.name} — the backend worked, this query genuinely matched nothing).`;
    }

    const lines: string[] = [`Search results for: "${query}" (via ${attempt.name})`, ''];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    });
    return lines.join('\n');
  }

  // Every backend failed. This is an infrastructure error, NOT an empty result.
  return `Error: web_search is unavailable — every backend failed.\n\n${failures.map(f => `  - ${f}`).join('\n')}\n\n${NO_BACKEND_HELP}`;
}

/**
 * Is search usable at all right now? One cheap probe, for callers that plan a
 * multi-step research phase and would otherwise send an agent into a wall —
 * see runDesignX. Returns the backend that answered, or why none did.
 *
 * A keyed backend is trusted without a network call: keys are checked at use
 * time, and spending a quota credit to ask "does my quota work" is a poor
 * trade. Only the unkeyed DuckDuckGo path is actually probed, because that is
 * the one that silently stops working.
 */
export async function probeSearchAvailability(): Promise<{ available: boolean; backend?: string; reason?: string }> {
  const brave = getApiKey('BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY');
  if (brave) return { available: true, backend: 'Brave' };
  const tavily = getApiKey('TAVILY_API_KEY');
  if (tavily) return { available: true, backend: 'Tavily' };

  const outcome = await duckDuckGoSearch('design', 'wt-wt');
  if (outcome.ok && outcome.results.length > 0) return { available: true, backend: 'DuckDuckGo' };
  return {
    available: false,
    reason: outcome.ok ? 'DuckDuckGo returned no results for a control query' : outcome.reason,
  };
}

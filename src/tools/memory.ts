import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';
import { auraPath } from '../util/aura-home.js';

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Memory — cross-session knowledge store
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryInput {
  action: 'remember' | 'recall' | 'forget' | 'list' | 'search';
  key?: string;
  value?: string;
  namespace?: string;
  /** Free-text query for `search`. */
  query?: string;
  /** Max hits returned by `search` (default 5, capped at 20). */
  limit?: number;
}

export const MEMORY_DEFINITION: ToolDefinition = {
  name: 'memory',
  description:
    'Persistent memory that survives across sessions. Store, retrieve, list, and delete key-value pairs. ' +
    'Use for remembering user preferences, project context, decisions, personal info. ' +
    'Only a small identity summary is in your system prompt — when you need a fact you do not ' +
    'have, use action=search with a free-text query BEFORE guessing or asking the user.',
  parameters: {
    type: 'object',
    properties: {
      action:    { type: 'string', description: 'Action: remember, recall, forget, list, search' },
      key:       { type: 'string', description: 'Memory key (required for remember/recall/forget)' },
      value:     { type: 'string', description: 'Value to store (required for remember)' },
      namespace: { type: 'string', description: 'Optional namespace (default: "default"; search scans all namespaces unless one is given)' },
      query:     { type: 'string', description: 'Free-text query (required for search)' },
      limit:     { type: 'number', description: 'Max search hits (default 5)' },
    },
    required: ['action'],
  },
};

function memoryDir(): string {
  const dir = auraPath('memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryPath(namespace: string): string {
  return path.join(memoryDir(), `${namespace}.json`);
}

function loadStore(namespace: string): Record<string, { value: string; updated: string }> {
  const p = memoryPath(namespace);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(namespace: string, store: Record<string, { value: string; updated: string }>): void {
  const p = memoryPath(namespace);
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
}

export async function memoryTool(input: MemoryInput): Promise<string> {
  const ns = input.namespace ?? 'default';

  switch (input.action) {
    case 'remember': {
      if (!input.key) return 'Error: key is required for remember';
      if (input.value === undefined) return 'Error: value is required for remember';
      const store = loadStore(ns);
      store[input.key] = { value: input.value, updated: new Date().toISOString() };
      saveStore(ns, store);
      return `Remembered "${input.key}" in namespace "${ns}"`;
    }

    case 'recall': {
      if (!input.key) return 'Error: key is required for recall';
      const store = loadStore(ns);
      const entry = store[input.key];
      if (!entry) return `No memory found for key "${input.key}" in namespace "${ns}"`;
      // An uncapped recall let one large remember() value flood the context
      // whole — match the search path's 600-char ceiling instead.
      const MAX_VALUE_CHARS = 600;
      const value = entry.value.length > MAX_VALUE_CHARS
        ? entry.value.slice(0, MAX_VALUE_CHARS)
          + `\n…[truncated: ${(entry.value.length - MAX_VALUE_CHARS).toLocaleString()} chars omitted]`
        : entry.value;
      return `Memory [${input.key}]: ${value}\n(Last updated: ${entry.updated})`;
    }

    case 'forget': {
      if (!input.key) return 'Error: key is required for forget';
      const store = loadStore(ns);
      if (!store[input.key]) return `No memory found for key "${input.key}" in namespace "${ns}"`;
      delete store[input.key];
      saveStore(ns, store);
      return `Forgot "${input.key}" in namespace "${ns}"`;
    }

    case 'list': {
      const store = loadStore(ns);
      const keys = Object.keys(store);
      if (keys.length === 0) return `No memories in namespace "${ns}"`;
      const lines = keys.map(k => `• ${k}: ${store[k].value.slice(0, 100)}${store[k].value.length > 100 ? '...' : ''}`);
      return `Memories in namespace "${ns}" (${keys.length}):\n${lines.join('\n')}`;
    }

    case 'search':
      return searchMemory(input.query ?? '', input.namespace, input.limit ?? 5);

    default:
      return `Error: Unknown memory action: ${input.action}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search — the escalation path out of a trimmed system-prompt memory block.
//
// The prompt carries only a short identity summary, so the agent regularly
// needs a fact it does not have in context. Exact-key `recall` cannot help
// there: it has to already know the key. `search` scores every entry across
// every namespace by term overlap on key + value and returns the best few,
// which keeps the retrieved text in the conversation rather than the cacheable
// system prefix — the tier can go up for one question without re-charging the
// whole prompt.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lowercased, de-duplicated words of length ≥3 — the scoring unit. Hyphens
 * split: keys are kebab-case, so "chemistry-moles" must be reachable from a
 * query of "chemistry".
 */
function terms(text: string): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9_.+]+/)) {
    if (w.length >= 3) seen.add(w);
  }
  return [...seen];
}

function namespaces(only?: string): string[] {
  if (only) return [only];
  try {
    return fs.readdirSync(memoryDir())
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5));
  } catch {
    return ['default'];
  }
}

function searchMemory(query: string, namespace: string | undefined, limit: number): string {
  const q = terms(query);
  if (q.length === 0) return 'Error: query is required for search';
  const cap = Math.min(Math.max(limit, 1), 20);

  interface Hit { ns: string; key: string; value: string; score: number }
  const hits: Hit[] = [];

  for (const ns of namespaces(namespace)) {
    const store = loadStore(ns);
    for (const [key, entry] of Object.entries(store)) {
      const value = entry?.value ?? '';
      if (!value) continue;
      const hay = terms(`${key} ${value}`);
      // A key match is worth more than a body match: keys are curated labels,
      // bodies are prose where a term can appear incidentally.
      const keyTerms = new Set(terms(key));
      let score = 0;
      for (const t of q) {
        if (keyTerms.has(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      if (score > 0) hits.push({ ns, key, value, score });
    }
  }

  if (hits.length === 0) return `No memories match "${query}".`;

  hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const lines = hits.slice(0, cap).map(h => {
    const body = h.value.length > 600 ? h.value.slice(0, 600) + '…' : h.value;
    return `• [${h.ns}/${h.key}] ${body}`;
  });
  const more = hits.length > cap ? `\n(${hits.length - cap} more — narrow the query or raise limit)` : '';
  return `Memory search "${query}" — ${Math.min(hits.length, cap)} of ${hits.length}:\n${lines.join('\n')}${more}`;
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Episodic memory — things that happened, in the order they happened.
 *
 * Distinct from tools/memory.ts, which is a key-value store of settled facts
 * ("prefers tabs"). An episode is a moment with a time and a context: a memo
 * dictated on a walk, a decision taken mid-task. You do not look it up by key,
 * because you do not remember the key — you remember roughly what it was about,
 * which is why the only useful operation here is search.
 *
 * Stored as JSONL: append-only, survives a partial write losing at most the
 * last line, and greppable by hand. A memo recorded on a phone is not worth a
 * database.
 */

/**
 * Resolved per call rather than at module load, matching server/devices.ts.
 * A constant computed at import time freezes the home directory for the life
 * of the process, which breaks anything that sets HOME afterwards — tests
 * most obviously, but also a service that drops privileges after start.
 */
function memoryDir(): string {
  return path.join(os.homedir(), '.aura', 'memory');
}

export function episodesPath(): string {
  return path.join(memoryDir(), 'episodes.jsonl');
}

export interface Episode {
  id: string;
  /** When the thing happened, not when it was filed. */
  at: string;
  /** Where it came from: 'memo', 'session', 'note'. */
  kind: string;
  /** Short label for listings. */
  title: string;
  /** The content itself — a memo transcript, a decision, a summary. */
  text: string;
  /** Free tags, e.g. the device that recorded it or the project it concerned. */
  tags: string[];
}

export interface EpisodeHit extends Episode {
  /** Higher is a better match. Only meaningful relative to the same query. */
  score: number;
  /** The part of the text that matched, for display. */
  excerpt: string;
}

function ensureDir(): void {
  const dir = memoryDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadEpisodes(): Episode[] {
  try {
    return fs.readFileSync(episodesPath(), 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line) as Episode; } catch { return null; }
      })
      // A single corrupt line must not lose the whole history, which is the
      // reason for line-delimited storage in the first place.
      .filter((e): e is Episode => !!e && typeof e.text === 'string');
  } catch {
    return [];
  }
}

export interface AddEpisodeInput {
  kind: string;
  title?: string;
  text: string;
  tags?: string[];
  at?: string;
  /** Supplied by the phone so a re-sync does not duplicate the memo. */
  id?: string;
}

/** Append an episode. Returns it, or the existing one if the id is known. */
export function addEpisode(input: AddEpisodeInput): Episode {
  ensureDir();
  const id = input.id ?? crypto.randomUUID();

  const existing = loadEpisodes().find(e => e.id === id);
  // Idempotent by id: phones retry, and a memo that appears three times in
  // recall is worse than one that appears none.
  if (existing) return existing;

  const episode: Episode = {
    id,
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    title: (input.title?.trim() || firstLine(input.text)),
    text: input.text.trim(),
    tags: input.tags ?? [],
  };
  fs.appendFileSync(episodesPath(), JSON.stringify(episode) + '\n', { mode: 0o600 });
  return episode;
}

export function deleteEpisode(id: string): boolean {
  const all = loadEpisodes();
  const kept = all.filter(e => e.id !== id);
  if (kept.length === all.length) return false;
  ensureDir();
  fs.writeFileSync(
    episodesPath(),
    kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''),
    { mode: 0o600 },
  );
  return true;
}

/**
 * Find episodes matching a query.
 *
 * Deliberately lexical rather than embeddings: this runs on a laptop with no
 * vector store and no embedding budget, over a corpus of at most a few
 * thousand short notes, and someone searching their own memos usually
 * remembers a distinctive word from them. Scoring favours rarer terms, so
 * "kayak" outranks "the", and matches in the title count double.
 */
export function searchEpisodes(query: string, limit = 8): EpisodeHit[] {
  const terms = tokenise(query);
  if (terms.length === 0) return [];

  const all = loadEpisodes();
  if (all.length === 0) return [];

  // Inverse document frequency, so a term appearing in every episode
  // contributes almost nothing to the ranking.
  const df = new Map<string, number>();
  const tokenised = all.map(e => {
    const tokens = new Set(tokenise(`${e.title} ${e.text} ${e.tags.join(' ')}`));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens;
  });

  const hits: EpisodeHit[] = [];
  all.forEach((episode, i) => {
    const tokens = tokenised[i];
    const titleTokens = new Set(tokenise(episode.title));
    let score = 0;
    let matched = 0;

    for (const term of terms) {
      if (!tokens.has(term)) continue;
      matched++;
      const idf = Math.log(1 + all.length / (df.get(term) ?? 1));
      score += idf;
      if (titleTokens.has(term)) score += idf;
    }

    if (matched === 0) return;
    // Every term present beats a single common word appearing often.
    if (matched === terms.length) score *= 1.5;
    hits.push({ ...episode, score, excerpt: excerptFor(episode.text, terms) });
  });

  return hits
    // Ties broken by recency: given equal relevance, the newer memory is
    // almost always the one being looked for.
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Most recent episodes, for "what have I been thinking about". */
export function recentEpisodes(limit = 10): Episode[] {
  return loadEpisodes()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

function firstLine(text: string): string {
  const line = text.trim().split('\n').find(l => l.trim()) ?? '';
  return line.length > 70 ? line.slice(0, 70).trim() + '…' : line || 'Untitled';
}

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    // Unicode-aware: the memos this is built for are often Serbian, and
    // splitting on [a-z] alone would reduce them to nothing.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1);
}

/** A window of text around the first match, so a hit is recognisable. */
function excerptFor(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 160).trim();
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + 120);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

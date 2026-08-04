import * as fs from 'fs';
import * as path from 'path';

/**
 * `:rem` — parses the entity-tagged dream files under `<projectRoot>/dreams/`
 * into a relations graph, so patterns across MANY nights become visible
 * (not just the latest night's raw text, which is all the old `:rem` did).
 *
 * Parsing contract (must stay in sync with `src/dream/dream.ts`'s
 * `buildConsolidationPrompt` — see that file's header comment too):
 *   - Each dream file starts with `# Dream — <date>`.
 *   - `## Lessons` and `## Open threads` sections contain bullets of the form
 *     `- [tag] free text`. Tags are free-form, lowercase-by-convention
 *     (e.g. [routing], [todo], [bug]) — NOT a fixed enum, so the parser must
 *     not assume a closed tag set.
 *   - `## Patterns` bullets are untagged prose; we don't graph these, but we
 *     do count them as a per-night weight signal.
 *
 * Graph model: two node kinds —
 *   - a `night` node per dream file (one per date)
 *   - a `tag` node per distinct `[tag]` seen anywhere
 * An edge connects a night to every tag that appeared in it, weighted by how
 * many times that tag appeared that night. This is deliberately simple
 * (bipartite, not a general knowledge graph) — it's meant to answer "what
 * keeps coming up, and when", not model deep semantic relations.
 */

export interface TagOccurrence {
  tag: string;
  text: string;
  /** Which section the bullet came from. */
  section: 'lessons' | 'open-threads';
}

export interface DreamNight {
  date: string;
  file: string;
  episodeCount: number;
  occurrences: TagOccurrence[];
  patternCount: number;
}

export interface GraphNode {
  id: string;
  kind: 'night' | 'tag';
  /** For tag nodes: total occurrences across all nights. For night nodes: episodeCount. */
  weight: number;
}

export interface GraphEdge {
  night: string; // night node id (= date)
  tag: string;   // tag node id
  weight: number; // occurrences of this tag on this night
}

export interface RemGraph {
  nights: DreamNight[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Tags sorted by total occurrence, descending — the "what keeps coming up" view. */
  topTags: { tag: string; count: number; nights: number }[];
}

const TAG_BULLET = /^-\s*\[([^\]]+)\]\s*(.+)$/;
const HEADER_META = /^>\s*(\d+)\s+episodes?\b/i;

/**
 * Parse a single dream markdown file into its structured night record.
 * Tolerant of missing sections — a malformed or hand-edited file degrades to
 * an empty occurrence list rather than throwing, since dream files are
 * sometimes hand-edited (e.g. the 2026-06-22 provider-failure dream had only
 * a one-line [error] lesson and no Patterns).
 */
export function parseDreamFile(filePath: string): DreamNight {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  const base = path.basename(filePath, '.md');
  const dateMatch = base.match(/\d{4}-\d{2}-\d{2}/);
  const date = dateMatch ? dateMatch[0] : base;

  let episodeCount = 0;
  let section: 'lessons' | 'open-threads' | 'patterns' | 'other' = 'other';
  const occurrences: TagOccurrence[] = [];
  let patternCount = 0;

  for (const line of lines) {
    const metaMatch = line.match(HEADER_META);
    if (metaMatch) episodeCount = parseInt(metaMatch[1], 10);

    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      const title = h[1].trim().toLowerCase();
      if (title === 'lessons') section = 'lessons';
      else if (title === 'open threads') section = 'open-threads';
      else if (title === 'patterns') section = 'patterns';
      else section = 'other';
      continue;
    }

    if (section === 'patterns') {
      if (/^-\s+/.test(line) && !/^-\s*none\s*$/i.test(line.trim())) patternCount++;
      continue;
    }

    if (section !== 'lessons' && section !== 'open-threads') continue;

    const m = line.match(TAG_BULLET);
    if (!m) continue;
    const tag = m[1].trim().toLowerCase();
    const text = m[2].trim();
    if (!tag) continue;
    occurrences.push({ tag, text, section });
  }

  return { date, file: filePath, episodeCount, occurrences, patternCount };
}

/** Load and parse every `*.md` dream file in `<projectRoot>/dreams/`, oldest first. */
export function loadDreamNights(projectRoot: string): DreamNight[] {
  const dir = path.join(projectRoot, 'dreams');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return files.map(f => parseDreamFile(path.join(dir, f)));
}

/** Build the bipartite night↔tag relations graph from a set of parsed nights. */
export function buildRemGraph(nights: DreamNight[]): RemGraph {
  const tagTotals = new Map<string, number>();
  const tagNightCounts = new Map<string, Set<string>>();
  const edges: GraphEdge[] = [];

  for (const night of nights) {
    const perNightCounts = new Map<string, number>();
    for (const occ of night.occurrences) {
      perNightCounts.set(occ.tag, (perNightCounts.get(occ.tag) ?? 0) + 1);
    }
    for (const [tag, count] of perNightCounts) {
      edges.push({ night: night.date, tag, weight: count });
      tagTotals.set(tag, (tagTotals.get(tag) ?? 0) + count);
      if (!tagNightCounts.has(tag)) tagNightCounts.set(tag, new Set());
      tagNightCounts.get(tag)!.add(night.date);
    }
  }

  const nodes: GraphNode[] = [
    ...nights.map(n => ({ id: n.date, kind: 'night' as const, weight: n.episodeCount })),
    ...[...tagTotals.entries()].map(([tag, weight]) => ({ id: tag, kind: 'tag' as const, weight })),
  ];

  const topTags = [...tagTotals.entries()]
    .map(([tag, count]) => ({ tag, count, nights: tagNightCounts.get(tag)?.size ?? 0 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return { nights, nodes, edges, topTags };
}

/** Convenience: load + build in one call for the given project root. */
export function loadRemGraph(projectRoot: string): RemGraph {
  return buildRemGraph(loadDreamNights(projectRoot));
}

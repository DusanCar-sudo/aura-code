import * as fs from 'fs';
import * as path from 'path';

/**
 * Dream parser — turns a dream markdown file back into a structured
 * `ParsedDream` so reconciliation can dedupe, conflict-check, and project
 * bullets across multiple days.
 *
 * Round-trips files written by `runDream()` in dream.ts. The contract with
 * the writer is fixed: four sections in a fixed order, each containing
 * bullets that may or may not start with a `[tag]` prefix. Bullets may be
 * separated by blank lines, may have trailing whitespace, and may use
 * either `-` or `*` markers — all real artifacts seen in production dreams.
 *
 * This is the FOUNDATION for memory reconciliation (CONFLICT/STRENGTHEN/
 * SUPERSEDE/MERGE/KEEP/DROP). The reconciler reads many ParsedDreams,
 * groups bullets by section, then asks the LLM to reconcile. The parser
 * must be permissive on input (real dream files vary) and lossless on
 * structure (every bullet kept, with its source date attached).
 *
 * What the parser does NOT do:
 *   - Validate tag values. `[foo]` is fine even if it's not a known category.
 *   - Drop empty sections — they round-trip as empty arrays.
 *   - Interpret bullet semantics. That's the reconciler's job.
 */

/** A single bullet from a dream section, with its source for annotation. */
export interface DreamBullet {
  /** Optional `[tag]` prefix at the start of the bullet (e.g. "tooling"). */
  tag?: string;
  /** Bullet text with tag prefix and bullet marker stripped, whitespace trimmed. */
  text: string;
  /** Source dream date (YYYY-MM-DD), set by `parseDreamFile` from the filename. */
  sourceDate: string;
}

/** A dream file parsed into its four canonical sections. */
export interface ParsedDream {
  /** YYYY-MM-DD from the filename (e.g. "2026-06-26"). */
  date: string;
  /** Absolute path the dream was read from. */
  path: string;
  lessons: DreamBullet[];
  patterns: DreamBullet[];
  openThreads: DreamBullet[];
  /** "Tomorrow brief" — free prose, not bullets. Stored as one string or empty. */
  tomorrowBrief: string;
}

const SECTION_HEADERS = {
  lessons: /^##\s+Lessons\s*$/i,
  patterns: /^##\s+Patterns\s*$/i,
  openThreads: /^##\s+Open\s+threads\s*$/i,
  tomorrowBrief: /^##\s+Tomorrow\s+brief\s*$/i,
} as const;

type SectionKey = keyof typeof SECTION_HEADERS;

/** Match a bullet line: `- text`, `* text`, optionally indented. */
const BULLET_RE = /^\s*[-*]\s+(.*)$/;

/** Match a `[tag]` prefix at the very start of bullet text. */
const TAG_RE = /^\[([^\]]+)\]\s*(.*)$/;

/** Match the "# Dream — DATE" title line (em dash or plain hyphen). */
const TITLE_RE = /^#\s+Dream\s*[—–-]\s*(\d{4}-\d{2}-\d{2})/;

function extractDateFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.md');
  const m = base.match(/^(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : '';
}

function extractDateFromContent(md: string): string {
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(TITLE_RE);
    if (m) return m[1];
  }
  return '';
}

function parseBullet(line: string, sourceDate: string): DreamBullet | null {
  const m = line.match(BULLET_RE);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  const tagMatch = body.match(TAG_RE);
  if (tagMatch) {
    const tag = tagMatch[1].trim();
    const text = tagMatch[2].trim();
    if (!text) {
      // `- [tag]` with no actual content — treat as untagged with the tag as text
      return { text: `[${tag}]`, sourceDate };
    }
    return { tag, text, sourceDate };
  }
  return { text: body, sourceDate };
}

/**
 * Parse dream markdown content. Caller supplies the source date (preferred
 * from filename for cross-OS consistency); falls back to the title line if
 * the filename doesn't encode it.
 */
export function parseDreamMarkdown(md: string, sourceDate: string): Omit<ParsedDream, 'path'> {
  const date = sourceDate || extractDateFromContent(md);
  const lines = md.split(/\r?\n/);

  const sections: Record<SectionKey, string[]> = {
    lessons: [],
    patterns: [],
    openThreads: [],
    tomorrowBrief: [],
  };

  let current: SectionKey | null = null;

  for (const line of lines) {
    // Detect section transitions.
    let matched: SectionKey | null = null;
    for (const [key, re] of Object.entries(SECTION_HEADERS) as [SectionKey, RegExp][]) {
      if (re.test(line)) {
        matched = key;
        break;
      }
    }
    if (matched) {
      current = matched;
      continue;
    }
    // Any other `##` heading ends the current section.
    if (/^##\s+/.test(line)) {
      current = null;
      continue;
    }
    if (current) sections[current].push(line);
  }

  const lessons: DreamBullet[] = [];
  const patterns: DreamBullet[] = [];
  const openThreads: DreamBullet[] = [];

  for (const line of sections.lessons) {
    const b = parseBullet(line, date);
    if (b) lessons.push(b);
  }
  for (const line of sections.patterns) {
    const b = parseBullet(line, date);
    if (b) patterns.push(b);
  }
  for (const line of sections.openThreads) {
    const b = parseBullet(line, date);
    if (b) openThreads.push(b);
  }

  // Tomorrow brief is free prose — join non-empty lines.
  const tomorrowBrief = sections.tomorrowBrief
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  return { date, lessons, patterns, openThreads, tomorrowBrief };
}

/** Read and parse a single dream file from disk. */
export function parseDreamFile(filePath: string): ParsedDream {
  const md = fs.readFileSync(filePath, 'utf8');
  const sourceDate = extractDateFromFilename(filePath) || extractDateFromContent(md);
  const parsed = parseDreamMarkdown(md, sourceDate);
  return { ...parsed, path: filePath };
}

/**
 * Load and parse every `YYYY-MM-DD.md` dream file in `<projectRoot>/dreams/`.
 * Returned oldest-first (chronological), so reconciliation can iterate
 * forward in time when reasoning about strengthening / conflicts.
 *
 * Ignores `.last.json` and `.reconciled.md` (handled separately).
 * Returns `[]` if the dreams directory doesn't exist yet.
 */
export function loadExistingDreams(projectRoot: string): ParsedDream[] {
  const dir = path.join(projectRoot, 'dreams');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const dreamFiles = entries
    .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort(); // lexical sort works for ISO dates
  return dreamFiles.map(name => parseDreamFile(path.join(dir, name)));
}

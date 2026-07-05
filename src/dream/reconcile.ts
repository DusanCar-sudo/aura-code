import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider } from '../providers/types.js';
import type { ParsedDream, DreamBullet } from './parser.js';

/**
 * Dream reconciliation — the "sleep-time compute" layer.
 *
 * Takes all parsed dreams (from parser.ts's `loadExistingDreams`) and
 * produces a RECONCILED VIEW: a single `.reconciled.md` file containing
 * the agent's current best understanding, with annotations showing where
 * each belief came from and how it evolved.
 *
 * Six verdicts:
 *   KEEP       — unique claim, no conflict, retained as-is.
 *   STRENGTHEN — same claim appeared across multiple dreams. Confidence up.
 *   MERGE      — two related-but-distinct claims combined into one.
 *   SUPERSEDE  — newer claim replaces an older one.
 *   CONFLICT   — two claims contradict each other. Both surfaced, not resolved.
 *   DROP       — exact duplicate or obsolete. Removed from the projection.
 *
 * Confidence is MECHANICAL, not model-generated:
 *   confidence = (number of source dreams contributing to this bullet) / totalDreams
 * This makes the number defensible. A model-generated "0.72" is theater;
 * "appears in 8 of 14 dreams → 0.57" is data.
 *
 * Output: `dreams/.reconciled.md` — a projection, not a replacement.
 * Old dream files stay untouched (append-only audit trail).
 *
 * The reconciliation log is also appended to today's dream file as a
 * `## Reconciliation` section for traceability.
 */

export type VerdictAction = 'KEEP' | 'STRENGTHEN' | 'MERGE' | 'SUPERSEDE' | 'CONFLICT' | 'DROP';

export interface ReconciledBullet {
  section: 'lessons' | 'patterns' | 'openThreads';
  tag?: string;
  text: string;
  action: VerdictAction;
  /** Human-readable lineage, e.g. "from 2026-06-24, strengthened 2026-06-26" */
  annotation: string;
  sourceDates: string[];
  /** Mechanical: sourceDates.length / totalDreams. */
  confidence: number;
  /** For CONFLICT: the opposing claim and its date. */
  conflictsWith?: { text: string; date: string };
}

export interface ReconciliationResult {
  bullets: ReconciledBullet[];
  totalDreams: number;
  /** Markdown string written to .reconciled.md (also returned for appending to dream file). */
  reconciledMd: string;
  /** Compact log appended to today's dream file. */
  logSection: string;
}

// ── Prompt construction ──────────────────────────────────────────────────────

type Section = 'lessons' | 'patterns' | 'openThreads';
const SECTIONS: Section[] = ['lessons', 'patterns', 'openThreads'];

function formatBulletsForPrompt(dreams: ParsedDream[]): string {
  const blocks: string[] = [];
  for (const section of SECTIONS) {
    const label = section === 'openThreads' ? 'Open threads' : section.charAt(0).toUpperCase() + section.slice(1);
    const bullets: string[] = [];
    for (const dream of dreams) {
      for (const b of dream[section] as DreamBullet[]) {
        const tag = b.tag ? `[${b.tag}] ` : '';
        bullets.push(`  - (${b.sourceDate}) ${tag}${b.text}`);
      }
    }
    if (bullets.length > 0) {
      blocks.push(`### ${label}\n${bullets.join('\n')}`);
    }
  }
  return blocks.join('\n\n');
}

function buildReconciliationPrompt(dreams: ParsedDream[]): { system: string; user: string } {
  const system = `You are Aura's memory reconciliation system. You are given ALL bullets from ${dreams.length} dream files (the agent's nightly consolidation journal), grouped by section (Lessons, Patterns, Open threads). Each bullet is prefixed with its source date.

Your job: produce a RECONCILED memory — the current best understanding — by analyzing all bullets across all dreams.

For each bullet in your output, assign exactly ONE verdict:

- KEEP: unique claim, no overlap with others, retained as-is.
- STRENGTHEN: the same claim (or very similar) appeared in multiple dreams. Cite all dates.
- MERGE: two related but distinct claims combined into one clearer statement. Cite both source dates.
- SUPERSEDE: a newer claim replaces an older one (the old one is outdated). Cite both dates and state which is old vs new.
- CONFLICT: two claims contradict each other. Surface BOTH — do NOT resolve. State what conflicts with what.
- DROP: exact duplicate of another bullet already in the output. Do not include it.

IMPORTANT RULES:
- Do NOT invent new claims. Only work with what's in the input.
- Do NOT silently merge contradictions. If something changed, mark it CONFLICT or SUPERSEDE.
- Prefer CONFLICT over SUPERSEDE when you're unsure which is more current.
- Tags like [tooling], [bug], [todo] should be preserved when present.
- Open threads marked [todo] should be kept unless explicitly resolved by a later dream's lesson.

Respond with ONLY a JSON array. No markdown fences, no preamble, no explanation.

Each element:
{
  "section": "lessons" | "patterns" | "openThreads",
  "tag": "optional tag without brackets, or null",
  "text": "the reconciled bullet text",
  "action": "KEEP" | "STRENGTHEN" | "MERGE" | "SUPERSEDE" | "CONFLICT" | "DROP",
  "sourceDates": ["2026-06-24", "2026-06-26"],
  "conflictsWith": { "text": "the opposing claim", "date": "2026-06-24" } // only for CONFLICT, otherwise omit
}`;

  const user = `Here are all ${dreams.length} dreams' bullets:\n\n${formatBulletsForPrompt(dreams)}`;

  return { system, user };
}

// ── LLM response parsing ─────────────────────────────────────────────────────

interface RawVerdict {
  section?: string;
  tag?: string | null;
  text?: string;
  action?: string;
  sourceDates?: string[];
  conflictsWith?: { text?: string; date?: string } | null;
}

const VALID_ACTIONS = new Set<VerdictAction>(['KEEP', 'STRENGTHEN', 'MERGE', 'SUPERSEDE', 'CONFLICT', 'DROP']);

function parseVerdicts(raw: string, totalDreams: number): ReconciledBullet[] {
  // Strip markdown fences if the model wrapped the JSON
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: RawVerdict[];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract a JSON array from the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const results: ReconciledBullet[] = [];
  for (const v of parsed) {
    if (!v.text || !v.section || !v.action) continue;
    const action = v.action.toUpperCase() as VerdictAction;
    if (!VALID_ACTIONS.has(action)) continue;
    if (action === 'DROP') continue; // dropped bullets don't appear in output
    if (!SECTIONS.includes(v.section as Section)) continue;

    const sourceDates = Array.isArray(v.sourceDates) ? v.sourceDates.filter(d => typeof d === 'string') : [];
    const confidence = totalDreams > 0 ? Math.round((sourceDates.length / totalDreams) * 100) / 100 : 0;

    const bullet: ReconciledBullet = {
      section: v.section as Section,
      tag: (typeof v.tag === 'string' && v.tag.trim()) ? v.tag.trim() : undefined,
      text: v.text.trim(),
      action,
      annotation: buildAnnotation(action, sourceDates, v.conflictsWith),
      sourceDates,
      confidence,
    };

    if (action === 'CONFLICT' && v.conflictsWith && typeof v.conflictsWith.text === 'string') {
      bullet.conflictsWith = {
        text: v.conflictsWith.text.trim(),
        date: typeof v.conflictsWith.date === 'string' ? v.conflictsWith.date : 'unknown',
      };
    }

    results.push(bullet);
  }

  return results;
}

function buildAnnotation(
  action: VerdictAction,
  sourceDates: string[],
  conflict?: { text?: string; date?: string } | null,
): string {
  const dates = sourceDates.join(', ');
  switch (action) {
    case 'KEEP':
      return sourceDates.length === 1 ? `from ${dates}` : `from ${dates}`;
    case 'STRENGTHEN':
      return `from ${sourceDates[0]}, strengthened ${sourceDates.slice(1).join(', ')}`;
    case 'MERGE':
      return `merged from ${dates}`;
    case 'SUPERSEDE':
      return sourceDates.length >= 2
        ? `superseded ${sourceDates[0]}, current from ${sourceDates[sourceDates.length - 1]}`
        : `superseded, current from ${dates}`;
    case 'CONFLICT':
      return conflict?.date ? `conflicts with ${conflict.date}` : `conflicting claims from ${dates}`;
    case 'DROP':
      return 'dropped';
  }
}

// ── Output formatting ────────────────────────────────────────────────────────

function buildReconciledMd(bullets: ReconciledBullet[], totalDreams: number): string {
  const now = new Date().toISOString().slice(0, 10);

  // Frontmatter
  const avgConfidence = bullets.length > 0
    ? Math.round((bullets.reduce((s, b) => s + b.confidence, 0) / bullets.length) * 100) / 100
    : 0;
  const frontmatter = [
    '---',
    `generated: ${now}`,
    `source_dreams: ${totalDreams}`,
    `total_beliefs: ${bullets.length}`,
    `average_confidence: ${avgConfidence}`,
    `last_reconciliation: ${now}`,
    '---',
  ].join('\n');

  // Group by section
  const bySection: Record<Section, ReconciledBullet[]> = {
    lessons: [],
    patterns: [],
    openThreads: [],
  };
  for (const b of bullets) bySection[b.section].push(b);

  // Render each section
  const renderBullets = (items: ReconciledBullet[]): string => {
    if (items.length === 0) return '- none\n';
    return items
      .map(b => {
        const tag = b.tag ? `[${b.tag}] ` : '';
        const conf = ` (confidence: ${b.confidence})`;
        return `- ${tag}${b.text} *${b.annotation}*${conf}`;
      })
      .join('\n') + '\n';
  };

  // Separate conflicts section
  const conflicts = bullets.filter(b => b.action === 'CONFLICT');
  const conflictsSection = conflicts.length > 0
    ? '\n## Conflicts\n\n' + conflicts.map(b => {
      const against = b.conflictsWith
        ? `"${b.conflictsWith.text}" (${b.conflictsWith.date})`
        : 'unknown prior belief';
      return `- **${b.text}** vs ${against}`;
    }).join('\n') + '\n'
    : '';

  // Stats summary
  const actionCounts: Record<string, number> = {};
  for (const b of bullets) actionCounts[b.action] = (actionCounts[b.action] ?? 0) + 1;
  const statsLine = Object.entries(actionCounts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  return [
    frontmatter,
    '',
    `# Aura — Reconciled Memory`,
    '',
    `> Projected from ${totalDreams} dream(s). ${statsLine}.`,
    '',
    '## Lessons',
    '',
    renderBullets(bySection.lessons),
    '## Patterns',
    '',
    renderBullets(bySection.patterns),
    '## Open threads',
    '',
    renderBullets(bySection.openThreads),
    conflictsSection,
    '---',
    '',
    '*Generated by Aura Code · dream reconciliation · event-sourced memory.*',
  ].join('\n');
}

function buildLogSection(bullets: ReconciledBullet[], totalDreams: number): string {
  const actionCounts: Record<string, number> = {};
  for (const b of bullets) actionCounts[b.action] = (actionCounts[b.action] ?? 0) + 1;
  const statsLine = Object.entries(actionCounts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  const conflicts = bullets.filter(b => b.action === 'CONFLICT');
  const conflictLines = conflicts.length > 0
    ? '\n' + conflicts.map(b => {
      const vs = b.conflictsWith ? ` vs "${b.conflictsWith.text}" (${b.conflictsWith.date})` : '';
      return `- CONFLICT: "${b.text}"${vs}`;
    }).join('\n')
    : '';

  return [
    `\n## Reconciliation`,
    '',
    `> Reconciled ${totalDreams} dream(s): ${statsLine}.`,
    `> Projection written to \`dreams/.reconciled.md\`.`,
    conflictLines,
  ].join('\n').trimEnd() + '\n';
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run memory reconciliation across all existing dreams.
 *
 * Called by `runDream()` after the new dream is written, gated at ≥3 dreams.
 * If this fails, the dream file is still intact — reconciliation is
 * enhancement, not critical path.
 *
 * @returns The result, or null if reconciliation was skipped or failed.
 */
export async function reconcileDreams(opts: {
  projectRoot: string;
  provider: LLMProvider;
  /** Pre-loaded dreams (avoids re-reading disk). */
  dreams: ParsedDream[];
}): Promise<ReconciliationResult | null> {
  const { projectRoot, provider, dreams } = opts;

  if (dreams.length < 3) return null; // 3-dream gate

  const totalDreams = dreams.length;
  const { system, user } = buildReconciliationPrompt(dreams);

  let rawResponse: string;
  try {
    const res = await provider.complete(system, [{ role: 'user', content: user }], []);
    rawResponse = (res.text ?? '').trim();
    if (!rawResponse) return null;
  } catch {
    return null; // reconciliation is best-effort
  }

  const bullets = parseVerdicts(rawResponse, totalDreams);
  if (bullets.length === 0) return null;

  const reconciledMd = buildReconciledMd(bullets, totalDreams);
  const logSection = buildLogSection(bullets, totalDreams);

  // Write .reconciled.md
  const dir = path.join(projectRoot, 'dreams');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, '.reconciled.md');
  fs.writeFileSync(outPath, reconciledMd);

  return { bullets, totalDreams, reconciledMd, logSection };
}

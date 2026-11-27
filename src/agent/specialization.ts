/**
 * Agent specialization — one agent, one or two skills.
 *
 * The catalog in project-skills.ts lists every installed skill and asks the
 * model to route on it. That works at a dozen skills and collapses at two
 * hundred: the catalog is capped at MAX_CATALOG_CHARS, entries are sorted by
 * name, and everything past the cap is silently unroutable. On this machine
 * 216 skills produce a ~72 KB index — roughly 18k tokens of permanent
 * overhead, and the skills that matter most (the ones actually matching the
 * task) are alphabetically late and get cut.
 *
 * A specialization inverts it. Instead of "here are 216 skills, pick one",
 * the agent is told what it is *for this task* and given only the skills that
 * serve it. Everything else stays on disk, unread.
 *
 * Two ways to specialize, in priority order:
 *
 *   1. Explicit — `.aura/specialize.json` in the project root. A person or a
 *      script names the skills. Deterministic, reviewable, wins always.
 *   2. Inferred — the task text is classified against each skill's name and
 *      description. Cheap (no LLM call, same philosophy as domain-expertise.ts
 *      and loop-profile.ts) and good enough to pick the two or three that
 *      obviously belong.
 *
 * Nothing here removes skills. A specialization is a lens, not a deletion —
 * `:skills` still shows the full catalog, and any task can widen the lens.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectSkill } from '../plugins/project-skills.js';

/** A task-scoped view of the skill catalog. */
export interface Specialization {
  /** Skills selected for this task, in routing order. */
  skills: ProjectSkill[];
  /** How the selection was made — shown by `:skills` so it is never invisible. */
  source: 'explicit' | 'inferred' | 'none';
  /** One line explaining the selection, for the prompt and for `:skills`. */
  reason: string;
}

/** Hard ceiling on how many skills one task may carry. Two is the design
 *  centre; three is the ceiling, because a task that genuinely needs four is
 *  two tasks. */
export const MAX_TASK_SKILLS = 3;

const SPECIALIZE_FILE = '.aura/specialize.json';

/** Weights for inferred matching. A hit in the skill *name* is worth more
 *  than a hit in its description, because names are terse and deliberate
 *  while descriptions are prose that often mentions adjacent topics. */
const NAME_WEIGHT = 3;
const DESC_WEIGHT = 1;

/**
 * Words too common to carry routing signal. Without this, "build" or "test"
 * matches half the catalog and the ranking degenerates into alphabetical
 * order again — which is the exact failure this module exists to fix.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at',
  'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'once',
  'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'is', 'am',
  'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'doing', 'would', 'could', 'of', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'my',
  'your', 'me', 'us', 'them', 'please', 'make', 'build', 'create', 'write',
  'use', 'using', 'need', 'want', 'help', 'fix', 'add', 'update', 'change',
]);

/** Split text into lowercase word tokens, dropping stopwords and very short
 *  fragments. Single characters and pure numbers carry no routing signal. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Score one skill against the task. Name matches dominate; description
 * matches add weight but cannot carry a skill on their own past a name-less
 * tie, which is what keeps the ranking honest.
 */
function scoreSkill(taskTokens: string[], skill: ProjectSkill): number {
  const nameTokens = new Set(tokens(`${skill.name} ${path.basename(path.dirname(skill.path))}`));
  const descTokens = new Set(tokens(skill.description));

  let score = 0;
  for (const t of taskTokens) {
    if (nameTokens.has(t)) score += NAME_WEIGHT;
    if (descTokens.has(t)) score += DESC_WEIGHT;
  }
  return score;
}

/**
 * Read `.aura/specialize.json` from the project root.
 *
 * Shape, deliberately forgiving because this is hand-edited:
 *   { "skills": ["tdd-workflow", "systematic-debugging"] }
 *   { "skills": "tdd-workflow" }
 *
 * Returns [] when the file is absent, unreadable, malformed, or names nothing
 * — a broken specialization must never be able to brick a task.
 */
export function readExplicitSpecialization(projectRoot: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectRoot, SPECIALIZE_FILE), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const value = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' && 'skills' in parsed)
      ? (parsed as { skills: unknown }).skills
      : null;

  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];

  return value
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * Resolve a specialization for one task.
 *
 * Explicit names win outright: if `.aura/specialize.json` names skills that
 * exist, those are the answer and no inference runs. Otherwise the task text
 * is scored against the catalog and the top MAX_TASK_SKILLS scorers are kept,
 * but only those that actually scored — a task matching nothing returns
 * source 'none' rather than an arbitrary alphabetical trio.
 */
export function resolveSpecialization(task: string, catalog: ProjectSkill[]): Specialization {
  if (catalog.length === 0) {
    return { skills: [], source: 'none', reason: 'no skills installed' };
  }

  const explicit = readExplicitSpecialization(catalog[0] ? path.dirname(path.dirname(path.dirname(catalog[0].path))) : '.');
  if (explicit.length > 0) {
    const byName = new Map(catalog.map(s => [s.name, s]));
    const picked = explicit
      .map(name => byName.get(name))
      .filter((s): s is ProjectSkill => s !== undefined)
      .slice(0, MAX_TASK_SKILLS);
    if (picked.length > 0) {
      return {
        skills: picked,
        source: 'explicit',
        reason: `.aura/specialize.json names ${picked.map(s => s.name).join(', ')}`,
      };
    }
  }

  const taskTokens = tokens(task);
  if (taskTokens.length === 0) {
    return { skills: [], source: 'none', reason: 'task has no routing signal' };
  }

  const ranked = catalog
    .map(s => ({ skill: s, score: scoreSkill(taskTokens, s) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_TASK_SKILLS);

  if (ranked.length === 0) {
    return { skills: [], source: 'none', reason: 'no skill matched the task' };
  }

  return {
    skills: ranked.map(r => r.skill),
    source: 'inferred',
    reason: `matched on task keywords: ${ranked.map(r => r.skill.name).join(', ')}`,
  };
}

/**
 * Render the specialized catalog as a prompt block.
 *
 * Deliberately says what was left out and how to get it back. A lens the
 * agent does not know it is looking through is worse than no lens: the model
 * would assume the catalog is complete and never widen it.
 */
export function formatSpecializedCatalog(spec: Specialization, catalogSize: number): string {
  if (spec.skills.length === 0) return '';

  const rows = spec.skills
    .map(s => `- ${s.name} — ${s.description}\n  ${s.path}`)
    .join('\n');

  const held = catalogSize - spec.skills.length;
  const heldLine = held > 0
    ? `\n${held} other skill${held === 1 ? '' : 's'} are installed but not loaded for this task. ` +
      `If none of the above fits, the full catalog is one command away: \`:skills\`. ` +
      `Do not read a skill you were not given unless the task genuinely needs it.`
    : '';

  return `\n\n## Available skills
You are specialized for this task (${spec.reason}). These are the skills that
apply. Read the SKILL.md of a matching one BEFORE starting work, and follow it.

${rows}${heldLine}`;
}

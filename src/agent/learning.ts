/**
 * The knowledge-gap loop — how a run that would have given up finishes anyway,
 * and how what it worked out survives into the next session.
 *
 * The loop already had every piece of this except the wiring. It could search
 * the web, it could write to memory, and `:research` could run a focused
 * investigation — but nothing connected them, so all three waited on a human to
 * notice the agent was stuck and say the right word. What actually happened at
 * a stall was `return { success: false, summary: 'Loop stalled.' }`: the run
 * ended holding everything it had learned, and threw it away.
 *
 * So this module closes the loop at the one moment the economics are clearly
 * favourable — the point where the run is already lost. A research pass costs
 * tokens, but it is spending them on a task that would otherwise have returned
 * nothing at all, which is the cheapest possible place to put that bet. It runs
 * once per run, never twice.
 *
 * The sequence is deliberately memory-first:
 *
 *   1. Ask the model, in one cheap non-tool call, to name what it does not know.
 *   2. Search what Aura already learned. This is free — keyword matching over
 *      stored lessons and episodes, no LLM call — so it always runs before any
 *      spend. A gap closed from memory costs nothing, which is the entire point
 *      of having written the lesson down the first time.
 *   3. Only on a miss, research it: a bounded, read-only sub-run.
 *   4. Hand the finding back so the main run can finish.
 *   5. Write the lesson down, so step 3 never has to happen for this gap again.
 *
 * Scope follows the shape of the fact, not the shape of the session. A quirk of
 * a provider's API is true everywhere and belongs in ~/.aura; a quirk of one
 * repo's test setup is false everywhere else and belongs beside that repo. The
 * computer-use lessons store already made this argument for machine-scoped
 * facts (see tools/screen/lessons.ts) — this is the same reasoning applied to
 * the other two scopes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';
import { PermissionSystem } from '../safety/permissions.js';
import { searchEpisodes } from './episodic-memory.js';
import { auraPath } from '../util/aura-home.js';

// ── Storage ─────────────────────────────────────────────────────────────────

export type LessonScope = 'global' | 'project';

export interface Lesson {
  /** Dedupe key. The same gap learned twice must not append twice. */
  key: string;
  text: string;
  scope: LessonScope;
  learnedAt: string;
}

/** Kept small on purpose. These go into every system prompt, and a lessons
 *  file that grows without limit quietly becomes the largest thing in the
 *  context window. Oldest out first. */
export const MAX_LESSONS_PER_SCOPE = 80;

export function globalLessonsPath(): string {
  return auraPath('memory', 'lessons-global.md');
}

export function projectLessonsPath(projectRoot: string): string {
  return path.join(projectRoot, '.aura', 'lessons.md');
}

function lessonsPathFor(scope: LessonScope, projectRoot?: string): string | null {
  if (scope === 'global') return globalLessonsPath();
  return projectRoot ? projectLessonsPath(projectRoot) : null;
}

/** One bullet per lesson, with the dedupe key in a trailing comment. Markdown
 *  because these files are read by humans and pasted into prompts unchanged —
 *  a JSON store would need rendering on both paths for no gain. */
const LINE = /^- (.*?)\s*<!-- k:([a-z0-9-]+) t:(\S+) -->$/;

export function loadLessons(scope: LessonScope, projectRoot?: string): Lesson[] {
  const p = lessonsPathFor(scope, projectRoot);
  if (!p) return [];
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out: Lesson[] = [];
  for (const line of raw.split('\n')) {
    const m = LINE.exec(line.trim());
    if (m) out.push({ text: m[1], key: m[2], learnedAt: m[3], scope });
  }
  return out;
}

/** Turn free text into a stable dedupe key. Same gap, same key, one bullet. */
export function lessonKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'lesson';
}

/**
 * Append a lesson. Returns false when it was already known — a repeat is a
 * no-op rather than a duplicate bullet, so a fact re-derived on three
 * successive runs still occupies one line.
 */
export function recordLesson(
  text: string,
  scope: LessonScope,
  projectRoot?: string,
  key = lessonKey(text),
): boolean {
  const p = lessonsPathFor(scope, projectRoot);
  if (!p) return false;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;

  const existing = loadLessons(scope, projectRoot);
  if (existing.some(l => l.key === key)) return false;

  const kept = [...existing, { key, text: clean, scope, learnedAt: new Date().toISOString().slice(0, 10) }]
    .slice(-MAX_LESSONS_PER_SCOPE);

  const body = kept.map(l => `- ${l.text} <!-- k:${l.key} t:${l.learnedAt} -->`).join('\n');
  const header = scope === 'global'
    ? '# Lessons Aura has learned (all projects)\n\n'
    : '# Lessons Aura has learned in this project\n\n';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, header + body + '\n', 'utf8');
    return true;
  } catch {
    // An unwritable home must not fail the run it was learned in. The cost of
    // losing the write is re-researching later, which is exactly the state we
    // were already in.
    return false;
  }
}

/**
 * Remove a lesson by key. Returns false when nothing matched.
 *
 * Anything that writes into its own prompt needs a way to be corrected. A
 * lesson learned from a bad source, or true only on the day it was recorded,
 * would otherwise be asserted to the model on every future run with no way for
 * the user to see it, let alone stop it.
 */
export function forgetLesson(key: string, scope: LessonScope, projectRoot?: string): boolean {
  const p = lessonsPathFor(scope, projectRoot);
  if (!p) return false;
  const existing = loadLessons(scope, projectRoot);
  const kept = existing.filter(l => l.key !== key);
  if (kept.length === existing.length) return false;

  const header = scope === 'global'
    ? '# Lessons Aura has learned (all projects)\n\n'
    : '# Lessons Aura has learned in this project\n\n';
  const body = kept.map(l => `- ${l.text} <!-- k:${l.key} t:${l.learnedAt} -->`).join('\n');
  try {
    fs.writeFileSync(p, header + (body ? body + '\n' : ''), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── Recall (free — no LLM call) ─────────────────────────────────────────────

/** Words too common to carry meaning in a match. Kept short: an over-eager
 *  stoplist silently makes recall miss the thing it was written for. */
const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'when', 'how',
  'why', 'does', 'not', 'you', 'are', 'was', 'has', 'have', 'can', 'its',
  'into', 'about', 'need', 'want', 'use', 'using', 'run', 'add', 'fix',
]);

function terms(text: string): string[] {
  return [...new Set(
    text.toLowerCase().split(/[^a-z0-9_.\-/]+/).filter(w => w.length > 2 && !STOP.has(w)),
  )];
}

function score(haystack: string, want: string[]): number {
  const hay = haystack.toLowerCase();
  return want.reduce((n, w) => (hay.includes(w) ? n + 1 : n), 0);
}

export interface RecallHit { text: string; source: string; }

/**
 * What Aura already knows that bears on this text. Pure string matching by
 * design: it runs on the failure path where the budget is already strained,
 * and a recall step that costs an LLM call would be one more thing to skip
 * when things are going badly.
 */
export function recallForTask(query: string, projectRoot?: string, limit = 6): RecallHit[] {
  const want = terms(query);
  if (want.length === 0) return [];

  const hits: Array<RecallHit & { n: number }> = [];

  for (const scope of ['global', 'project'] as const) {
    for (const l of loadLessons(scope, projectRoot)) {
      const n = score(l.text, want);
      if (n > 0) hits.push({ text: l.text, source: `lesson/${scope}`, n });
    }
  }

  try {
    for (const ep of searchEpisodes(query, limit)) {
      const text = [ep.title, ep.text].filter(Boolean).join(' — ');
      if (text) hits.push({ text, source: 'episode', n: score(text, want) });
    }
  } catch { /* episode store unavailable; lessons alone are still useful */ }

  return hits
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map(({ text, source }) => ({ text, source }));
}

/** Render recall hits as a prompt block, or '' when there is nothing to say. */
export function formatRecall(hits: RecallHit[]): string {
  if (hits.length === 0) return '';
  return ['What you already learned that bears on this:', ...hits.map(h => `- ${h.text}  [${h.source}]`)].join('\n');
}

// ── Scope classification ────────────────────────────────────────────────────

/**
 * Where does this fact belong? A fact naming a path, a filename, or this
 * repo is about *this* codebase and would be noise — or worse, wrong —
 * elsewhere. Everything else is treated as a fact about the world.
 *
 * Deliberately biased toward `project`: a general fact filed as project-local
 * costs one re-derivation in the next repo, while a project quirk filed as
 * global is asserted, confidently and wrongly, in every future session.
 */
export function classifyScope(text: string, projectRoot?: string): LessonScope {
  const t = text.toLowerCase();
  const repo = projectRoot ? path.basename(projectRoot).toLowerCase() : null;
  const localSignals = [
    /\bsrc\//, /\btests?\//, /\bdist\//, /\.\//, /\bthis (repo|project|codebase)\b/,
    /\b[\w-]+\.(ts|js|tsx|jsx|py|go|rs|json|md|yml|yaml)\b/,
  ];
  if (repo && t.includes(repo)) return 'project';
  return localSignals.some(re => re.test(t)) ? 'project' : 'global';
}

// ── The gap pass ────────────────────────────────────────────────────────────

const NAME_THE_GAP = [
  'You are about to stop without finishing. Before that, name the single thing you',
  'do not know that is blocking you — not what you tried, what you are MISSING.',
  '',
  'Reply in exactly this form and nothing else:',
  'GAP: <one sentence: the fact you lack>',
  'QUERY: <a search query that would settle it>',
  '',
  'If you are not blocked by missing knowledge — you had the information and',
  'simply ran out of turns, or the task is genuinely done — reply exactly:',
  'GAP: none',
].join('\n');

export interface GapPassResult {
  /** True when there is a finding worth resuming with. */
  resolved: boolean;
  /** The gap the model named, for display and for the lesson key. */
  gap?: string;
  /** What closed it, from memory or from research. */
  finding?: string;
  /** Where the answer came from — memory is free, research is not. */
  via?: 'memory' | 'research';
  /** Whether a durable lesson was written (false = already knew it). */
  saved?: boolean;
  scope?: LessonScope;
}

export interface GapPassOptions {
  provider: LLMProvider;
  system: string;
  history: HistoryMessage[];
  task: string;
  context: ProjectContext;
  display: Display;
  /** Turn ceiling for the research sub-run. Small on purpose. */
  researchTurns?: number;
  abortSignal?: AbortSignal;
  budget?: import('./session-budget.js').SessionBudget;
}

function parseGap(text: string): { gap: string; query: string } | null {
  const gap = /GAP:\s*(.+)/i.exec(text)?.[1]?.trim();
  if (!gap || /^none\b/i.test(gap)) return null;
  const query = /QUERY:\s*(.+)/i.exec(text)?.[1]?.trim() || gap;
  return { gap, query };
}

/**
 * Run the gap pass. Never throws: this sits on the failure path, and an
 * exception here would replace a useful "loop stalled" message with a stack
 * trace about the recovery attempt.
 */
export async function runKnowledgeGapPass(opts: GapPassOptions): Promise<GapPassResult> {
  const { provider, display, context } = opts;
  try {
    // 1. Name the gap — one cheap call, no tools.
    const named = await provider.complete(
      opts.system,
      [...opts.history, { role: 'user', content: NAME_THE_GAP }],
      [],
    );
    const parsed = parseGap(named.text ?? '');
    if (!parsed) return { resolved: false };

    display.warning(`Not finished — missing: ${parsed.gap}`);

    // 2. Memory first. Free, and the whole reason lessons are written down.
    const hits = recallForTask(`${parsed.gap} ${parsed.query}`, context.root);
    if (hits.length > 0) {
      display.success(`Recalled ${hits.length} relevant lesson(s) — no research needed.`);
      return {
        resolved: true,
        gap: parsed.gap,
        finding: formatRecall(hits),
        via: 'memory',
        saved: false,
      };
    }

    // 3. Research it. Read-only and tool-limited: this is an investigation, and
    //    a sub-run that can write files is a sub-run that can damage the tree
    //    the main task is halfway through editing.
    const { runAgentLoop } = await import('./loop.js');
    const research = await runAgentLoop({
      provider,
      task: [
        `Find out: ${parsed.gap}`,
        `Suggested search: ${parsed.query}`,
        '',
        'Investigate with search and reading only. Do not edit anything.',
        'Finish with one line starting FINDING: stating the fact you established,',
        'specific enough to be useful without this conversation. If you could not',
        'establish it, reply exactly FINDING: none.',
      ].join('\n'),
      context,
      permissions: new PermissionSystem('read-only'),
      display,
      maxTurns: opts.researchTurns ?? 5,
      disableSpawn: true,
      skipInspector: true,
      allowedTools: ['web_search', 'web_fetch', 'read_file', 'search_code', 'list_dir'],
      abortSignal: opts.abortSignal,
      budget: opts.budget,
      // Depth 1. A gap pass that could trigger its own gap pass is a way to
      // spend an unbounded amount of money on a task that already failed.
      noGapPass: true,
    });

    const finding = /FINDING:\s*(.+)/i.exec(research.summary ?? '')?.[1]?.trim();
    if (!finding || /^none\b/i.test(finding)) return { resolved: false, gap: parsed.gap };

    // 4. Write it down, so this gap is free next time.
    const scope = classifyScope(finding, context.root);
    const saved = recordLesson(finding, scope, context.root, lessonKey(parsed.gap));
    if (saved) display.success(`Learned (${scope}): ${finding}`);

    return { resolved: true, gap: parsed.gap, finding, via: 'research', saved, scope };
  } catch {
    // Recovery is best-effort by definition.
    return { resolved: false };
  }
}

/** The message handed back to the stalled run so it can finish. */
export function formatResumption(result: GapPassResult, originalTask: string): string {
  return [
    'You stopped without finishing because you were missing something. Here it is:',
    '',
    result.finding ?? '',
    '',
    `Now finish the original task: ${originalTask}`,
    'Do not repeat the work you already completed — continue from where you stopped.',
  ].join('\n');
}

/**
 * Dream -> Reconcile -> Inject — layers 2-3 of the memory loop (MEMORY.md).
 * Dream spends exactly ONE LLM call. Reconciliation is pure statistics —
 * confidence is a literal ratio, never a model's guess.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider } from '../providers/types.js';
import * as os from 'os';
import { listEpisodes, listEpisodesSince, listAllEpisodes, type Episode } from './episode.js';

function dreamsDir(root: string): string {
  return path.join(root, 'dreams');
}

function todayFile(root: string): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(dreamsDir(root), `${d}.md`);
}

/**
 * Dated dream-store path for a mid-session flush (see generational-flush.ts).
 * Suffixed so multiple flushes in one day don't collide with each other or
 * with the end-of-session `todayFile()` dream — each is its own dream file,
 * picked up the same way by `listDreamFiles`/`runReconciliation`.
 */
export function sessionFlushFile(root: string, seq: number): string {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(dreamsDir(root), `${d}-flush-${seq}.md`);
}

function listDreamFiles(root: string): string[] {
  const dir = dreamsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}(-flush-\d+)?\.md$/.test(f))
    .sort(); // ISO dates + suffix sort chronologically as strings
}

function lastDreamTimestamp(root: string): number {
  const files = listDreamFiles(root);
  if (files.length === 0) return 0;
  const last = path.join(dreamsDir(root), files[files.length - 1]);
  try { return fs.statSync(last).mtimeMs; } catch { return 0; }
}

function formatEpisodesForPrompt(episodes: Episode[]): string {
  return episodes.map(e => {
    const date = new Date(e.timestamp).toISOString();
    return `- [${date}] (${e.model}, ${e.success ? 'success' : 'FAILED'}, ${e.tokens} tok, ${Math.round(e.durationMs / 1000)}s): ${e.task.slice(0, 200)}`;
  }).join('\n');
}

const DREAM_SYSTEM = [
  'You distill a set of recent coding-agent task episodes into a compact, dated memory entry.',
  'Write exactly four sections, in this order, as markdown headers: ## Lessons, ## Patterns, ## Open threads, ## Tomorrow brief.',
  'Lessons: concrete, specific things learned — file names, root causes, gotchas. Not generic advice.',
  'Patterns: recurring behavior across multiple episodes (which task types fail, which models struggle, repeated bugs).',
  'Open threads: unfinished work or unresolved questions visible from the episodes.',
  'Tomorrow brief: 2-4 sentences a future session should read first.',
  'Be concrete and specific. No filler, no generic AI-assistant advice.',
].join(' ');

/**
 * Spend one LLM call distilling `userContent` under `systemPrompt`, and
 * write the result to `outPath`. The one shared distillation primitive —
 * `runDream` uses it for episode batches, and a mid-session context-window
 * rollover (src/agent/generational-flush.ts) uses it for a recap block —
 * so both write into the same dream-store shape and both feed the same
 * `runReconciliation()` pass.
 */
export async function distillText(opts: {
  systemPrompt: string;
  userContent: string;
  provider: LLMProvider;
  outPath: string;
}): Promise<string> {
  const response = await opts.provider.complete(
    opts.systemPrompt,
    [{ role: 'user', content: opts.userContent }],
    [],
  );
  const text = response.text || '(model returned no content)';
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, text);
  return text;
}

/**
 * Run one dream cycle: consolidate episodes since the last dream into a
 * dated markdown file. Spends exactly one LLM call. Triggers reconciliation
 * automatically once >=3 dream files exist.
 */
export async function runDream(
  root: string,
  provider: LLMProvider,
  full = false,
): Promise<{ dreamPath: string; episodeCount: number; reconciled: boolean }> {
  const since = full ? 0 : lastDreamTimestamp(root);
  const episodes = since > 0 ? listEpisodesSince(root, since) : listEpisodes(root);

  fs.mkdirSync(dreamsDir(root), { recursive: true });

  if (episodes.length === 0) {
    const path_ = todayFile(root);
    fs.writeFileSync(path_, `## Lessons\n\n(no new episodes since the last dream)\n\n## Patterns\n\n## Open threads\n\n## Tomorrow brief\n\nNo new activity to report.\n`);
    return { dreamPath: path_, episodeCount: 0, reconciled: false };
  }

  const episodesText = formatEpisodesForPrompt(episodes);
  const dreamPath = todayFile(root);
  await distillText({
    systemPrompt: DREAM_SYSTEM,
    userContent: `${episodes.length} episodes${full ? ' (full — all recorded)' : ' since last dream'}:\n\n${episodesText}`,
    provider,
    outPath: dreamPath,
  });

  let reconciled = false;
  if (listDreamFiles(root).length >= 3) {
    runReconciliation(root);
    reconciled = true;
  }

  return { dreamPath, episodeCount: episodes.length, reconciled };
}

// ── Reconciliation — pure statistics, no LLM ────────────────────────────────

type Verdict = 'KEEP' | 'STRENGTHEN' | 'MERGE' | 'SUPERSEDE' | 'CONFLICT' | 'DROP';

interface Claim {
  text: string;
  topicKey: string;
  dreamFile: string;
  dreamIndex: number; // position among all dream files, chronological
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that']);
const NEGATIVE_WORDS = ['broken', 'fails', 'failing', 'wrong', 'bug', 'error', 'not', "doesn't", 'never'];
const POSITIVE_WORDS = ['works', 'fixed', 'working', 'resolved', 'correct', 'passes'];

function normalizeLine(line: string): string {
  return line.replace(/^[-*]\s*/, '').trim();
}

function topicKey(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 0 && !STOPWORDS.has(w));
  return words.slice(0, 6).join(' ');
}

function extractClaims(root: string, files: string[]): Claim[] {
  const claims: Claim[] = [];
  files.forEach((file, idx) => {
    const content = fs.readFileSync(path.join(dreamsDir(root), file), 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = normalizeLine(rawLine);
      if (line.startsWith('-') || line.length < 15) continue;
      if (line.startsWith('#')) continue;
      const key = topicKey(line);
      if (key.length < 5) continue;
      claims.push({ text: line, topicKey: key, dreamFile: file, dreamIndex: idx });
    }
    // Also catch actual bullet lines (lines starting with "- " after trim)
    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith('-')) continue;
      const line = normalizeLine(trimmed);
      if (line.length < 10) continue;
      const key = topicKey(line);
      if (key.length < 5) continue;
      claims.push({ text: line, topicKey: key, dreamFile: file, dreamIndex: idx });
    }
  });
  return claims;
}

function hasSentiment(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w));
}

/**
 * Reconcile all dream files into one projection. Pure statistics:
 * confidence = (number of dreams whose topicKey group contains this claim) / (total dream files).
 * This is a lexical-overlap heuristic (v1) — not full semantic dedup.
 */
export function runReconciliation(root: string): string {
  const files = listDreamFiles(root);
  const totalDreams = files.length;
  const claims = extractClaims(root, files);

  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    if (!groups.has(c.topicKey)) groups.set(c.topicKey, []);
    groups.get(c.topicKey)!.push(c);
  }

  const lines: string[] = ['# Reconciled Memory', '', `Generated from ${totalDreams} dream file(s).`, ''];

  for (const [key, group] of groups) {
    const distinctDreams = new Set(group.map(c => c.dreamFile)).size;
    const confidence = distinctDreams / totalDreams;
    const latest = group.reduce((a, b) => (b.dreamIndex > a.dreamIndex ? b : a));
    const oldest = group.reduce((a, b) => (b.dreamIndex < a.dreamIndex ? b : a));

    const hasPositive = group.some(c => hasSentiment(c.text, POSITIVE_WORDS));
    const hasNegative = group.some(c => hasSentiment(c.text, NEGATIVE_WORDS));

    let verdict: Verdict;
    if (hasPositive && hasNegative) {
      verdict = 'CONFLICT';
    } else if (distinctDreams === 1 && oldest.dreamIndex < totalDreams - 3) {
      verdict = 'DROP';
    } else if (group.length > distinctDreams) {
      verdict = 'MERGE';
    } else if (confidence >= 0.5) {
      verdict = 'STRENGTHEN';
    } else if (latest.dreamIndex !== oldest.dreamIndex && latest.text !== oldest.text) {
      verdict = 'SUPERSEDE';
    } else {
      verdict = 'KEEP';
    }

    if (verdict === 'DROP') continue; // dropped claims don't make the projection

    lines.push(`- **[${verdict}]** (confidence: ${confidence.toFixed(2)}) ${latest.text}`);
    lines.push(`  _source: ${[...new Set(group.map(c => c.dreamFile))].join(', ')}_`);
  }

  const output = lines.join('\n');
  fs.writeFileSync(path.join(dreamsDir(root), '.reconciled.md'), output);
  return output;
}

/** For :rem — the current reconciled projection, or the latest dream if reconciliation hasn't triggered yet. */
export function getReconciledOrLatest(root: string): { content: string; isReconciled: boolean } | null {
  const reconciledPath = path.join(dreamsDir(root), '.reconciled.md');
  if (fs.existsSync(reconciledPath)) {
    return { content: fs.readFileSync(reconciledPath, 'utf8'), isReconciled: true };
  }
  const files = listDreamFiles(root);
  if (files.length === 0) return null;
  const latest = path.join(dreamsDir(root), files[files.length - 1]);
  return { content: fs.readFileSync(latest, 'utf8'), isReconciled: false };
}

/**
 * Global lessons digest — pure statistics over EVERY project's episodes.
 * Written to ~/.aura/memory/lessons-global.md for the Telegram bot (which
 * isn't tied to one project). No LLM call: counts successes/failures per model
 * and surfaces the most recent activity. Mirrors runReconciliation's "trust
 * numbers, not a model's guess" philosophy.
 */
export function runGlobalReconciliation(): string {
  const episodes = listAllEpisodes();
  const outPath = path.join(os.homedir(), '.aura', 'memory', 'lessons-global.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (episodes.length === 0) {
    const empty = '# Global Lessons\n\n(no episodes recorded yet)\n';
    fs.writeFileSync(outPath, empty);
    return empty;
  }

  // Per-model success stats. Skip episodes with no model recorded (older
  // entries predate model capture) — they'd show as a meaningless "undefined".
  const byModel = new Map<string, { ok: number; fail: number }>();
  for (const e of episodes) {
    if (!e.model || e.model === 'undefined') continue;
    const m = byModel.get(e.model) ?? { ok: 0, fail: 0 };
    if (e.success) m.ok++; else m.fail++;
    byModel.set(e.model, m);
  }
  const total = episodes.length;
  const ok = episodes.filter(e => e.success).length;

  const lines: string[] = [
    '# Global Lessons (across all projects)',
    '',
    `Generated from ${total} episode(s) — ${ok} succeeded, ${total - ok} failed (${((ok / total) * 100).toFixed(0)}% success).`,
    '',
    '## Model reliability',
  ];
  for (const [model, s] of [...byModel.entries()].sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))) {
    const n = s.ok + s.fail;
    lines.push(`- **${model}**: ${s.ok}/${n} succeeded (${((s.ok / n) * 100).toFixed(0)}%)`);
  }

  // Most recent tasks (a quick "what has Aura been doing lately").
  lines.push('', '## Recent activity');
  for (const e of episodes.slice(-8).reverse()) {
    const date = new Date(e.timestamp).toISOString().slice(0, 10);
    lines.push(`- [${date}] ${e.success ? '✓' : '✗'} (${e.model}) ${e.task.slice(0, 120)}`);
  }

  const output = lines.join('\n') + '\n';
  fs.writeFileSync(outPath, output);
  return output;
}

/** For system-prompt injection — the reconciled memory, truncated, or empty string if none exists. */
export function loadReconciledMemorySection(root: string): string {
  const reconciledPath = path.join(dreamsDir(root), '.reconciled.md');
  if (!fs.existsSync(reconciledPath)) return '';
  try {
    const content = fs.readFileSync(reconciledPath, 'utf8').slice(0, 3000);
    return `\n\n### Memory (from past sessions)\n${content}`;
  } catch {
    return '';
  }
}

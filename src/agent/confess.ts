/**
 * :confess — post-mortem root-cause analysis for high-cost episodes.
 *
 * Triggered manually (REPL: :confess) or automatically when a task exceeds
 * the token threshold. Unlike the normal memory loop (passive → dream → reconcile),
 * confession is ACTIVE: it dedicates a separate LLM call to deep analysis of
 * the full conversation history, extracts a permanent lesson, and injects it
 * into the system prompt with elevated priority so the same mistake is never
 * repeated.
 *
 * Inspired by Catholic confession — acknowledge the failing, examine it
 * deeply, extract the lesson, and carry that lesson forward permanently.
 * Yes, it costs MORE tokens. But 20K now prevents 10M later.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { Episode } from '../dream/episode.js';
import { listEpisodes } from '../dream/episode.js';

const CONFESSIONS_DIR = path.join(os.homedir(), '.aura', 'confessions');
const DEFAULT_THRESHOLD = 500_000; // 500K tokens
const MAX_HISTORY_MESSAGES = 80; // cap for confession context

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'episode';
}

export interface ConfessionResult {
  path: string;
  episodeId: string;
  tokensSpent: number;
  tokensBurned: number; // the original episode's waste
  lesson: string;       // single most important takeaway
}

const CONFESSOR_SYSTEM = [
  'You are Aura\'s confessor — a forensic analyst examining a high-cost agent episode.',
  'Your job is NOT to summarise. Your job is to find the ROOT CAUSE of the waste.',
  '',
  'You receive:',
  '  1. Episode metadata (task, model, tokens burned, duration, success/fail)',
  '  2. The FULL conversation history from that session',
  '',
  'Analyse and respond with EXACTLY three sections (Markdown headers):',
  '',
  '## Root cause',
  'What specifically caused the token waste? Was it a logic loop? A model',
  'that doesn\'t have a stopping condition? Repeated tool calls that kept',
  'returning the same empty result? A prompt that was too open-ended?',
  'Be surgically specific — name exact tools, patterns, or model behaviours.',
  '',
  '## The pattern',  
  'What class of mistake is this? (e.g. "model continues tool-calling after',
  'tool returns empty results because no early-return check exists", or',
  '"prompt ambiguity causes the agent to re-read the same file 14 times").',
  'Name the pattern so it can be recognised in the future.',
  '',
  '## Permanent lesson',
  'A SINGLE sentence (max 160 chars) that, if injected into every future',
  'session, would prevent this exact class of waste from ever happening again.',
  'Make it concrete, specific, and actionable. Start with "NEVER" or "ALWAYS".',
  '',
  'Respond with ONLY these three sections. No preamble, no meta-commentary.',
].join('\n');

function buildConfessionPrompt(ep: Episode, historySummary: string): string {
  const lines: string[] = [
    `## Episode to confess`,
    '',
    `- **Task:** ${ep.task}`,
    `- **Model:** ${ep.model}`,
    `- **Tokens burned:** ${ep.tokens.toLocaleString()}`,
    `- **Duration:** ${Math.round(ep.durationMs / 1000)}s`,
    `- **Outcome:** ${ep.success ? 'success' : 'FAILED'}`,
    '',
    `## Conversation history`,
    '',
    historySummary,
    '',
    `Analyse this episode. What went wrong? What pattern is this? What permanent lesson prevents it forever?`,
  ];
  return lines.join('\n');
}

function summariseHistory(history: HistoryMessage[]): string {
  const capped = history.slice(-MAX_HISTORY_MESSAGES);
  return capped.map(m => {
    if (m.role === 'user') {
      return `**USER:** ${m.content.slice(0, 200)}`;
    }
    if (m.role === 'assistant') {
      const text = m.content.slice(0, 300);
      if (m.toolCalls && m.toolCalls.length > 0) {
        const tools = m.toolCalls.map(t => t.name).join(', ');
        return `**AURA** (calls: ${tools}): ${text}`;
      }
      return `**AURA:** ${text}`;
    }
    if (m.role === 'tool_result') {
      const first = m.results[0];
      if (!first) return '  → tool result: (empty)';
      const text = first.content.slice(0, 150);
      return `  → tool result: ${text}`;
    }
    return `[unknown role]: ...`;
  }).join('\n');
}

/**
 * Load the most recent session history for a project (the one closest to
 * the episode's timestamp). Best-effort — if no session matches, returns [].
 */
function findRecentSessionHistory(projectRoot: string, sinceMs: number): HistoryMessage[] {
  try {
    const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const dir = path.join(os.homedir(), '.aura', 'sessions', safe);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== 'latest.json')
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter(f => f.mtime >= sinceMs - 3600_000) // within 1 hour before episode
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return [];

    const raw = fs.readFileSync(path.join(dir, files[0].name), 'utf8');
    const parsed = JSON.parse(raw) as { history?: HistoryMessage[] };
    return Array.isArray(parsed.history) ? parsed.history : [];
  } catch {
    return [];
  }
}

/**
 * Find the most recent episode that exceeded the token threshold.
 */
export function findEpisodeToConfess(root: string, threshold = DEFAULT_THRESHOLD): Episode | null {
  const episodes = listEpisodes(root);
  if (episodes.length === 0) return null;
  // Find the most recent episode at or above threshold
  for (let i = episodes.length - 1; i >= 0; i--) {
    if (episodes[i].tokens >= threshold) return episodes[i];
  }
  return null;
}

/**
 * Run confession on a specific episode or the most recent high-cost one.
 * Returns the confession result with the extracted permanent lesson.
 */
export async function runConfession(opts: {
  projectRoot: string;
  episodeId?: string;
  provider: LLMProvider;
  threshold?: number;
  history?: HistoryMessage[]; // optional: explicit history override
}): Promise<ConfessionResult> {
  const { projectRoot, episodeId, provider, threshold = DEFAULT_THRESHOLD } = opts;

  // Find the episode
  let ep: Episode | null = null;
  if (episodeId) {
    ep = listEpisodes(projectRoot).find(e => e.id === episodeId) ?? null;
    if (!ep) throw new Error(`Episode not found: ${episodeId}`);
  } else {
    ep = findEpisodeToConfess(projectRoot, threshold);
    if (!ep) throw new Error(`No episode found with tokens >= ${threshold.toLocaleString()}. Use :confess <id> to confess a specific episode.`);
  }

  // Load history
  const history = opts.history ?? findRecentSessionHistory(projectRoot, ep.timestamp);
  const historySummary = history.length > 0
    ? summariseHistory(history)
    : `_(full conversation history not available — analysing from episode metadata only. Model: ${ep.model}, tokens: ${ep.tokens}, task: "${ep.task.slice(0, 150)}")_`;

  // Run the confessor
  const prompt = buildConfessionPrompt(ep, historySummary);
  const response = await provider.complete(CONFESSOR_SYSTEM, [{ role: 'user', content: prompt }], []);

  const body = (response.text ?? '').trim() || '_Confession produced no output._';
  
  // Extract the permanent lesson line
  const lessonMatch = body.match(/## Permanent lesson\n\n?(.+?)(?:\n|$)/s);
  const lesson = lessonMatch?.[1]?.trim() || '_No lesson extracted._';

  // Save
  fs.mkdirSync(CONFESSIONS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(ep.task);
  const fileName = `${date}-${slug}.md`;
  const filePath = path.join(CONFESSIONS_DIR, fileName);

  const md = [
    `# Confession: ${ep.task.slice(0, 80)}`,
    '',
    `- **Episode:** ${ep.id}`,
    `- **Model:** ${ep.model}`,
    `- **Tokens burned:** ${ep.tokens.toLocaleString()}`,
    `- **Duration:** ${Math.round(ep.durationMs / 1000)}s`,
    `- **Outcome:** ${ep.success ? 'success' : 'FAILED'}`,
    `- **Confessed:** ${new Date().toISOString()}`,
    '',
    body,
  ].join('\n');

  fs.writeFileSync(filePath, md);

  return {
    path: filePath,
    episodeId: ep.id,
    tokensSpent: response.usage ? (response.usage.inputTokens + response.usage.outputTokens) : 0,
    tokensBurned: ep.tokens,
    lesson,
  };
}

/**
 * Load the most recent confessions for injection into the system prompt.
 * Only returns confessions from the last 30 days, capped at 3.
 */
export function loadConfessionsSection(maxChars = 2000): string {
  try {
    if (!fs.existsSync(CONFESSIONS_DIR)) return '';
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    
    const files = fs.readdirSync(CONFESSIONS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f,
        path: path.join(CONFESSIONS_DIR, f),
        mtime: fs.statSync(path.join(CONFESSIONS_DIR, f)).mtimeMs,
      }))
      .filter(f => f.mtime > thirtyDaysAgo)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    if (files.length === 0) return '';

    const lessons: string[] = [];
    let used = 0;
    for (const f of files) {
      const content = fs.readFileSync(f.path, 'utf8');
      const lessonMatch = content.match(/## Permanent lesson\n\n?(.+?)(?:\n|$)/);
      if (lessonMatch) {
        const lesson = lessonMatch[1].trim();
        if (used + lesson.length > maxChars) break;
        lessons.push(`- **[CONFESSED]** ${lesson}`);
        used += lesson.length;
      }
    }

    return lessons.length > 0
      ? `\n### Confessions (lessons extracted from high-cost failures)\n${lessons.join('\n')}\n`
      : '';
  } catch {
    return '';
  }
}

/** List all confessions for a project */
export function listConfessions(): { file: string; tokens: number; lesson: string }[] {
  try {
    if (!fs.existsSync(CONFESSIONS_DIR)) return [];
    return fs.readdirSync(CONFESSIONS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = fs.readFileSync(path.join(CONFESSIONS_DIR, f), 'utf8');
        const tokMatch = content.match(/- \*\*Tokens burned:\*\* ([\d,]+)/);
        const lessonMatch = content.match(/## Permanent lesson\n\n?(.+?)(?:\n|$)/);
        return {
          file: f,
          tokens: tokMatch ? parseInt(tokMatch[1].replace(/,/g, ''), 10) : 0,
          lesson: lessonMatch?.[1]?.trim() || '_no lesson_',
        };
      })
      .sort((a, b) => b.tokens - a.tokens);
  } catch {
    return [];
  }
}

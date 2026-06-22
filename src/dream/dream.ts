import * as fs from 'fs';
import * as path from 'path';
import { loadEpisodes } from '../ruby/episode-capture.js';
import type { Episode } from '../ruby/types.js';
import type { LLMProvider } from '../providers/types.js';

/**
 * Aura's "dream": an offline consolidation pass over recorded episodes.
 *
 * Stages (minimum viable — Study/web research is a later, flag-driven add):
 *   1. Recall      — load episodes since the last dream.
 *   2. Consolidate — distil them into lessons + patterns via the LLM.
 *   3. Prepare     — write a short brief of open threads for tomorrow.
 *
 * Output is one dated Markdown file per night under `<projectRoot>/dreams/`.
 * The structure is deliberately stable and entity-tagged so a later pass
 * (`:rem`) can parse these files into a relations graph. Do not reformat the
 * headers without updating the parser.
 */

export interface DreamResult {
  path: string;
  date: string;
  episodeCount: number;
  recalledSince: number;
  skipped: boolean;
  reason?: string;
}

const DREAMS_DIRNAME = 'dreams';
const STATE_FILENAME = '.last.json';

function dreamsDir(projectRoot: string): string {
  return path.join(projectRoot, DREAMS_DIRNAME);
}

/** Timestamp (ms) of the last dream for this project, or 0 if never. */
export function lastDreamTimestamp(projectRoot: string): number {
  try {
    const raw = fs.readFileSync(path.join(dreamsDir(projectRoot), STATE_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { lastDreamTs?: number };
    return typeof parsed.lastDreamTs === 'number' ? parsed.lastDreamTs : 0;
  } catch {
    return 0;
  }
}

function writeState(projectRoot: string, lastDreamTs: number): void {
  const dir = dreamsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILENAME), JSON.stringify({ lastDreamTs }, null, 2));
}

/** Compact, low-token digest of one episode for the consolidation prompt. */
function digestEpisode(ep: Episode): string {
  const tier = ep.rubySucceeded ? 'ruby' : ep.largeModelUsed ? `large(${ep.largeModelUsed})` : 'none';
  const ok = ep.reviewerApproved ? 'approved' : 'unreviewed';
  const secs = Math.round(ep.durationMs / 1000);
  return `- [${ep.taskCategory}] "${ep.task.slice(0, 140)}" — tier=${tier}, ${ok}, ${secs}s`;
}

function buildConsolidationPrompt(episodes: Episode[]): { system: string; user: string } {
  const system =
    'You are Aura consolidating a day of work into durable memory, like a brain dreaming. ' +
    'You are given digests of today\'s task episodes. Produce concise, reusable knowledge — ' +
    'not a transcript. Be specific and tagged. Respond in GitHub Markdown with EXACTLY these ' +
    'sections and nothing else:\n\n' +
    '## Lessons\n(bullet list; each line starts with a [tag] in brackets, e.g. [routing], [tooling], [bug]. ' +
    'State what was learned, generalised beyond the single task.)\n\n' +
    '## Patterns\n(bullet list of recurring task shapes or failure modes seen across episodes.)\n\n' +
    '## Open threads\n(bullet list of unresolved problems worth picking up tomorrow; ' +
    'prefix each with [todo]. Empty bullet "- none" if nothing.)\n\n' +
    '## Tomorrow brief\n(2–4 sentences: what Aura should be ready for next session.)';
  const user =
    `Today's episodes (${episodes.length}):\n\n` +
    episodes.map(digestEpisode).join('\n');
  return { system, user };
}

function header(date: string, episodes: Episode[], since: number): string {
  const succeeded = episodes.filter(e => e.reviewerApproved).length;
  const rubyWins = episodes.filter(e => e.rubySucceeded).length;
  const sinceStr = since > 0 ? new Date(since).toISOString() : 'beginning';
  const cats = [...new Set(episodes.map(e => e.taskCategory))].join(', ') || '—';
  return (
    `# Dream — ${date}\n\n` +
    `> ${episodes.length} episodes recalled since ${sinceStr} · ` +
    `${succeeded} approved · ${rubyWins} ruby wins\n` +
    `> Categories: ${cats}\n`
  );
}

/**
 * Run a dream. Pure with respect to I/O sources: caller supplies the provider.
 * Never throws on an empty day — returns { skipped: true }.
 */
export async function runDream(opts: {
  projectRoot: string;
  provider: LLMProvider;
  /** Override the "since" cutoff (ms). Defaults to last dream timestamp. */
  since?: number;
  /** If true, consolidate ALL episodes regardless of last-dream cutoff. */
  full?: boolean;
}): Promise<DreamResult> {
  const { projectRoot, provider } = opts;
  const date = new Date().toISOString().slice(0, 10);
  const since = opts.full ? 0 : (opts.since ?? lastDreamTimestamp(projectRoot));

  const all = await loadEpisodes(projectRoot);
  const episodes = all.filter(e => e.timestamp > since);

  if (episodes.length === 0) {
    return { path: '', date, episodeCount: 0, recalledSince: since, skipped: true, reason: 'no new episodes since last dream' };
  }

  // Consolidate via the LLM.
  const { system, user } = buildConsolidationPrompt(episodes);
  let body: string;
  try {
    const res = await provider.complete(system, [{ role: 'user', content: user }], []);
    body = (res.text ?? '').trim();
  } catch (err) {
    body = `## Lessons\n- [error] consolidation model failed: ${err instanceof Error ? err.message : String(err)}\n\n## Patterns\n- none\n\n## Open threads\n- [todo] re-run :dream once the provider is reachable\n\n## Tomorrow brief\nConsolidation could not run; episodes are preserved and will be recalled next dream.`;
  }

  const md = `${header(date, episodes, since)}\n${body}\n`;

  const dir = dreamsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  // One file per date; re-running the same day overwrites that day's dream.
  const outPath = path.join(dir, `${date}.md`);
  fs.writeFileSync(outPath, md);

  // Advance the cutoff to the newest episode consolidated.
  const newest = Math.max(...episodes.map(e => e.timestamp));
  writeState(projectRoot, newest);

  return { path: outPath, date, episodeCount: episodes.length, recalledSince: since, skipped: false };
}

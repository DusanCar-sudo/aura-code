import * as fs from 'fs';
import * as path from 'path';
import { loadEpisodes } from '../ruby/episode-capture.js';
import type { Episode } from '../ruby/types.js';
import type { LLMProvider } from '../providers/types.js';
import { createProvider, checkOllamaHealth } from '../providers/factory.js';
import { loadExistingDreams } from './parser.js';
import { reconcileDreams } from './reconcile.js';

/**
 * Aura's "dream": an offline consolidation pass over recorded episodes.
 *
 * Stages:
 *   1. Recall      — load episodes since the last dream.
 *   2. Consolidate — distil them into lessons + patterns via the LLM.
 *   3. Prepare     — write a short brief of open threads for tomorrow.
 *   4. Reconcile   — if ≥3 existing dreams, run memory reconciliation
 *                    across all dreams and write `dreams/.reconciled.md`.
 *                    This step is BEST-EFFORT: if it fails, the dream
 *                    file is still written and the cutoff is advanced.
 *
 * Output is one dated Markdown file per night under `<projectRoot>/dreams/`.
 * The structure is deliberately stable and entity-tagged so a later pass
 * (`:rem`) can parse these files into a relations graph. Do not reformat the
 * headers without updating the parser (parser.ts).
 *
 * Memory reconciliation produces `dreams/.reconciled.md` — a PROJECTION
 * (materialized view) of current beliefs with annotations showing lineage.
 * Old dream files stay untouched as an append-only audit trail.
 */

export interface DreamResult {
  path: string;
  date: string;
  episodeCount: number;
  recalledSince: number;
  skipped: boolean;
  reason?: string;
  /** Set when the LLM consolidation failed — episodes are preserved and NOT burned. */
  providerError?: string;
  /** True if memory reconciliation ran successfully after the dream was written. */
  reconciled?: boolean;
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
 *
 * IMPORTANT: the `.last.json` state cutoff is only advanced when the LLM
 * consolidation succeeds. If the primary provider fails, a single retry on a
 * local Ollama instance is attempted before giving up gracefully. Episodes are
 * NEVER burned (cut off) when the provider is unreachable.
 *
 * After a successful dream write, memory reconciliation runs (if ≥3 dreams
 * exist). Reconciliation is best-effort — if it fails, the dream file and
 * cutoff are already committed. The reconciliation log is appended to today's
 * dream file for traceability, and `dreams/.reconciled.md` is updated as the
 * current memory projection.
 */
export async function runDream(opts: {
  projectRoot: string;
  provider: LLMProvider;
  /** Override the "since" cutoff (ms). Defaults to last dream timestamp. */
  since?: number;
  /** If true, consolidate ALL episodes regardless of last-dream cutoff. */
  full?: boolean;
  /**
   * Ollama model to use as a local fallback when the primary provider fails.
   * Set to false to disable. Defaults to 'llama3.2'.
   */
  ollamaFallbackModel?: string | false;
}): Promise<DreamResult> {
  const { projectRoot, provider } = opts;
  const ollamaFallbackModel =
    opts.ollamaFallbackModel === undefined ? 'llama3.2' : opts.ollamaFallbackModel;
  const date = new Date().toISOString().slice(0, 10);
  const since = opts.full ? 0 : (opts.since ?? lastDreamTimestamp(projectRoot));

  const all = await loadEpisodes(projectRoot);
  const episodes = all.filter(e => e.timestamp > since);

  if (episodes.length === 0) {
    return { path: '', date, episodeCount: 0, recalledSince: since, skipped: true, reason: 'no new episodes since last dream' };
  }

  // ── Consolidate via the LLM ──────────────────────────────────────────────
  // Critical invariant: we do NOT advance the cutoff unless this succeeds.
  const { system, user } = buildConsolidationPrompt(episodes);
  let body: string | undefined;
  let providerError: string | undefined;

  const tryComplete = async (p: LLMProvider): Promise<string> => {
    const res = await p.complete(system, [{ role: 'user', content: user }], []);
    const text = (res.text ?? '').trim();
    if (!text) throw new Error('Provider returned an empty response');
    return text;
  };

  // Primary attempt
  try {
    body = await tryComplete(provider);
  } catch (primaryErr) {
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);

    // ── Ollama fallback ───────────────────────────────────────────────────
    // Attempt one retry on a local Ollama instance before giving up.
    if (ollamaFallbackModel) {
      const ollamaBaseUrl = 'http://localhost:11434/v1';
      const ollamaHealthy = await checkOllamaHealth('http://localhost:11434').catch(() => false);
      if (ollamaHealthy) {
        try {
          const ollamaProvider = createProvider({
            model: `ollama/${ollamaFallbackModel}`,
            baseUrl: ollamaBaseUrl,
            // Dream consolidations are bounded by episode digest size, not raw
            // context — keep max_tokens conservative for small local models.
            maxTokens: 2048,
          });
          body = await tryComplete(ollamaProvider);
          // Ollama succeeded — note it but don't treat as an error.
          providerError = undefined;
        } catch (ollamaErr) {
          const ollamaMsg = ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr);
          providerError = `primary: ${primaryMsg}; ollama fallback: ${ollamaMsg}`;
        }
      } else {
        providerError = `${primaryMsg} (Ollama not reachable at ${ollamaBaseUrl})`;
      }
    } else {
      providerError = primaryMsg;
    }
  }

  // ── Provider failed — preserve episodes, return without writing state ─────
  if (providerError !== undefined) {
    return {
      path: '',
      date,
      episodeCount: episodes.length,
      recalledSince: since,
      skipped: true,
      reason: 'provider error — episodes preserved for next :dream run',
      providerError,
    };
  }

  // ── Write dream file ──────────────────────────────────────────────────────
  const md = `${header(date, episodes, since)}\n${body!}\n`;
  const dir = dreamsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  // One file per date; re-running the same day overwrites that day's dream.
  const outPath = path.join(dir, `${date}.md`);
  fs.writeFileSync(outPath, md);

  // Advance the cutoff ONLY on success.
  const newest = Math.max(...episodes.map(e => e.timestamp));
  writeState(projectRoot, newest);

  // ── Reconciliation (best-effort) ──────────────────────────────────────────
  // Gate: only runs when ≥3 dreams exist (handled inside reconcileDreams).
  // If this fails, the dream file and cutoff are already committed — no harm.
  let reconciled = false;
  try {
    const allDreams = loadExistingDreams(projectRoot);
    const result = await reconcileDreams({
      projectRoot,
      provider,
      dreams: allDreams,
    });
    if (result) {
      // Append reconciliation log to today's dream file for traceability.
      fs.appendFileSync(outPath, result.logSection);
      reconciled = true;
    }
  } catch {
    // Reconciliation failure is silent — dream is already saved.
  }

  return { path: outPath, date, episodeCount: episodes.length, recalledSince: since, skipped: false, reconciled };
}

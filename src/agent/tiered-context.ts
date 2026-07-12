/**
 * Tiered context strategy — ANCHOR + FACT-LOG + TAIL.
 *
 * Alternative to compactor.ts's escalating-recap strategy, gated behind
 * AURA_CONTEXT_STRATEGY=tiered so it can be A/B-compared against the default
 * rather than shipped as a silent replacement (see isTieredStrategyEnabled).
 *
 * - ANCHOR: history[0] (the original task) — never touched.
 * - TAIL: verbatim recent turns, sized identically to the default strategy
 *   (computeTailBoundary / RETENTION_RATIO from compactor.ts) so the two
 *   strategies fire at the same trigger and keep the same amount of raw
 *   recent context — the only variable being compared is what happens to
 *   the middle.
 * - FACT LOG: everything between anchor and tail, reduced to 1-3 bullet
 *   facts per turn (file changed, decision made, value set, command run +
 *   result). Bullets are stored in an on-disk sidecar (one JSON file per
 *   session, independent of the session's own history blob) and are
 *   strictly append-only: each compaction pass only asks the summary model
 *   to bullet-ize the newly-aged-out turns and appends the result — it never
 *   re-summarizes the existing log. That keeps the rendered fact-log message
 *   a stable-prefix-plus-appended-suffix across calls, which is what lets a
 *   cache breakpoint placed after it actually hit.
 * - Summarization runs on a separate, cheap/fast model (see
 *   resolveSummaryModel), not the session's main model, so the compaction
 *   pass itself doesn't eat the token savings it's trying to create.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { HistoryMessage, LLMProvider } from '../providers/types.js';
import { createProvider, getContextWindow } from '../providers/factory.js';
import { getApiKey, getEnv } from '../util/env.js';
import {
  RETENTION_RATIO,
  DEFAULT_WINDOW,
  thresholdRatio,
  computeTailBoundary,
  countMessage,
  countText,
  type CompactionExtras,
} from './compactor.js';

/** Marker prefixing the rendered fact-log placeholder message in `history`. */
const FACT_LOG_MARKER = '[Context fact log';

export function isTieredStrategyEnabled(): boolean {
  return getEnv('AURA_CONTEXT_STRATEGY') === 'tiered';
}

function isFactLogMessage(msg: HistoryMessage): msg is HistoryMessage & { role: 'assistant' } {
  return msg.role === 'assistant' && msg.content.startsWith(FACT_LOG_MARKER);
}

interface FactLog {
  /** How many compaction passes have appended to this log — drives the same
   *  escalating trigger ladder as the default strategy (thresholdRatio). */
  compactionCount: number;
  /** Append-only: one entry per aged-out turn's 1-3 bullets, oldest first. */
  bullets: string[];
}

const EMPTY_LOG: FactLog = { compactionCount: 0, bullets: [] };

/** In-memory fallback for ephemeral sessions (no sessionPath to persist to).
 *  Keyed by history array identity, matching compactHistory's in-place-mutate
 *  contract (the array reference is stable for the life of a run). */
const memoryLogs = new WeakMap<HistoryMessage[], FactLog>();

function sidecarPath(sessionPath: string): string {
  return sessionPath.replace(/\.json$/, '') + '.factlog.json';
}

function loadFactLog(sessionPath: string | undefined, history: HistoryMessage[]): FactLog {
  if (!sessionPath) return memoryLogs.get(history) ?? EMPTY_LOG;
  try {
    const raw = fs.readFileSync(sidecarPath(sessionPath), 'utf8');
    return JSON.parse(raw) as FactLog;
  } catch {
    return EMPTY_LOG;
  }
}

function saveFactLog(sessionPath: string | undefined, history: HistoryMessage[], log: FactLog): void {
  if (!sessionPath) {
    memoryLogs.set(history, log);
    return;
  }
  const target = sidecarPath(sessionPath);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(log, null, 2), 'utf8');
}

/**
 * Cheap/fast model used for middle-compression, resolved in priority order:
 *   1. AURA_CONTEXT_SUMMARY_MODEL — fully user-overridable (any model id
 *      the main session could use: Sonnet, Opus, Fable, local Ollama, ...).
 *   2. deepseek-v4-flash, if DEEPSEEK_API_KEY is set — the recommended
 *      default this feature was built and tested against.
 *   3. AURA_FALLBACK_MODEL (first entry if comma-separated).
 *   4. The session's own main model, as a last resort (still correct, just
 *      not "cheap" — better than failing compaction).
 */
export function resolveSummaryModel(mainModel: string): string {
  const override = getEnv('AURA_CONTEXT_SUMMARY_MODEL');
  if (override) return override;
  if (getApiKey('DEEPSEEK_API_KEY')) return 'deepseek-v4-flash';
  const fallback = getEnv('AURA_FALLBACK_MODEL');
  if (fallback) return fallback.split(',')[0].trim();
  return mainModel;
}

let summaryProviderCache: { model: string; provider: LLMProvider } | undefined;

function getSummaryProvider(mainModel: string): LLMProvider {
  const model = resolveSummaryModel(mainModel);
  if (summaryProviderCache?.model === model) return summaryProviderCache.provider;
  const provider = createProvider({ model });
  summaryProviderCache = { model, provider };
  return provider;
}

const BULLET_SYSTEM = [
  'You compress coding-session turns into a durable fact log.',
  'For each turn given, write 1-3 markdown bullets ("- ..."), each a concrete standalone fact:',
  'a file changed, a decision made, a value/config set, or a command run and its result.',
  'Be specific — file names, exact values, exit codes. No generic advice, no headers, no prose.',
  'Output ONLY bullet lines, one per line, in the same order as the turns given.',
].join(' ');

/** Fuller per-message transcript line than compactor's summariseMessage —
 *  the summary model gets more raw material to extract concrete facts from. */
function renderTurn(msg: HistoryMessage): string {
  switch (msg.role) {
    case 'user':
      return `User: ${msg.content.slice(0, 400)}`;
    case 'assistant': {
      const text = msg.content ? `Assistant: ${msg.content.slice(0, 400)}` : '';
      const calls = msg.toolCalls?.length
        ? `Called: ${msg.toolCalls.map(c => `${c.name}(${JSON.stringify(c.input).slice(0, 200)})`).join(', ')}`
        : '';
      return [text, calls].filter(Boolean).join('\n') || 'Assistant: (no content)';
    }
    case 'tool_result':
      return msg.results
        .map(r => `Result[${r.name}]${r.isError ? ' (error)' : ''}: ${(r.content ?? '').slice(0, 400)}`)
        .join('\n');
  }
}

async function summarizeTurns(turns: HistoryMessage[], mainModel: string): Promise<string[]> {
  if (turns.length === 0) return [];
  const provider = getSummaryProvider(mainModel);
  const transcript = turns.map((t, i) => `--- turn ${i + 1} (${t.role}) ---\n${renderTurn(t)}`).join('\n\n');
  const response = await provider.complete(BULLET_SYSTEM, [{ role: 'user', content: transcript }], []);
  const lines = response.text.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
  return lines.length > 0 ? lines : [`- ${turns.length} turns compacted (summary model returned no bullets)`];
}

function renderFactLog(log: FactLog): HistoryMessage & { role: 'assistant' } {
  return {
    role: 'assistant',
    content: [
      `${FACT_LOG_MARKER}: ${log.bullets.length} facts from earlier turns.]`,
      ...log.bullets,
    ].join('\n'),
  };
}

export interface TieredMetrics {
  strategy: 'tiered';
  beforeTokens: number;
  afterTokens: number;
  compactionCount: number;
  newBullets: number;
}

/**
 * Tiered counterpart to compactor.ts's compactHistory. Same trigger contract
 * (mutates `history` in place, fires on the same escalating threshold) but
 * async — the middle-compression bullet pass is an LLM call on the cheap
 * summary model.
 *
 * `extras` is accepted for call-site symmetry with compactHistory but
 * intentionally unused here: affectHint/executiveDigest are transient
 * per-call advisories, not historical facts, so they don't belong in an
 * append-only fact log.
 */
export async function compactHistoryTiered(
  history: HistoryMessage[],
  totalTokens: number,
  model: string,
  sessionPath: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  extras?: CompactionExtras,
): Promise<{ compacted: boolean; metrics?: TieredMetrics }> {
  const log = loadFactLog(sessionPath, history);
  const window = getContextWindow(model) ?? DEFAULT_WINDOW;
  const threshold = Math.floor(window * thresholdRatio(log.compactionCount));

  if (totalTokens < threshold) return { compacted: false };
  if (history.length <= 3) return { compacted: false };

  const keepFrom = computeTailBoundary(history, window);
  const middle = history.slice(1, keepFrom);
  // The existing fact-log placeholder (if any) sits at the front of `middle`
  // after a prior pass — its content is already captured in `log`, so it's
  // dropped rather than re-summarized (that's the incremental guarantee).
  const newTurns = middle.filter(msg => !isFactLogMessage(msg));

  if (newTurns.length === 0) return { compacted: false };

  const newBullets = await summarizeTurns(newTurns, model);
  const updatedLog: FactLog = {
    compactionCount: log.compactionCount + 1,
    bullets: [...log.bullets, ...newBullets],
  };
  saveFactLog(sessionPath, history, updatedLog);

  const placeholder = renderFactLog(updatedLog);
  const preserved = [history[0], placeholder, ...history.slice(keepFrom)];
  history.length = 0;
  for (const msg of preserved) history.push(msg);

  const afterTokens = countText(placeholder.content) + preserved.slice(2).reduce((sum, m) => sum + countMessage(m), 0) + countMessage(history[0]);

  return {
    compacted: true,
    metrics: {
      strategy: 'tiered',
      beforeTokens: totalTokens,
      afterTokens,
      compactionCount: updatedLog.compactionCount,
      newBullets: newBullets.length,
    },
  };
}

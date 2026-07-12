import type { HistoryMessage } from '../providers/types.js';
import { getContextWindow } from '../providers/factory.js';

/**
 * Escalating trigger ladder, indexed by "recap generation" (how many times
 * the current recap has already been through compaction). Later generations
 * tolerate more fill before firing again — that content is already dense/
 * pre-summarized, so there's less marginal value in acting early. Held at
 * the last value once the ladder is exhausted; ROLLOVER_AT_GENERATION caps
 * how many in-place rounds happen before a full generational flush (see
 * generational-flush.ts) instead of a further round of lossy recompaction.
 */
const LADDER = [0.55, 0.70, 0.85] as const;
export const ROLLOVER_AT_GENERATION = 3;
/** Verbatim recent-history budget kept through compaction, as a share of the
 *  window. 40% preserves interaction nuance over long sequences. Exported so
 *  the tiered strategy (tiered-context.ts) sizes its tail identically. */
export const RETENTION_RATIO = 0.40;
export const DEFAULT_WINDOW = 128_000;
/** Messages kept when no later user turn exists to anchor the tail. */
const FALLBACK_KEEP = 3;
/** Per-tool-result cap applied by the churn guard (see compactHistory). */
const MAX_RESULT_CHARS = 4_000;

/** Exported so the tiered strategy fires on the same escalating trigger as
 *  the default strategy — the two are meant to be A/B-comparable, not to
 *  differ in when they kick in, only in what they do once triggered. */
export function thresholdRatio(generation: number): number {
  return LADDER[Math.min(generation, LADDER.length - 1)];
}

/** Marker prefixing every recap message; also carries the generation number. */
const RECAP_MARKER = '[Earlier conversation compacted';

function isRecap(msg: HistoryMessage): msg is HistoryMessage & { role: 'assistant' } {
  return msg.role === 'assistant' && msg.content.startsWith(RECAP_MARKER);
}

/** Generation of the current recap (0 if history hasn't been compacted yet). */
export function getRecapGeneration(history: HistoryMessage[]): number {
  const recap = history.find(isRecap);
  if (!recap) return 0;
  const match = (recap as { content: string }).content.match(/\(gen (\d+)\)/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Index of the current recap message, or -1 if history hasn't been
 *  compacted yet. Used by generational-flush.ts to locate the recap it's
 *  about to flush and replace. */
export function findRecapIndex(history: HistoryMessage[]): number {
  return history.findIndex(isRecap);
}

/** Average characters per token used for the local size estimate. Deliberately
 *  conservative (real ratio is ~4 for English prose, lower for code/JSON) so we
 *  err toward compacting slightly early rather than overflowing. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Optional precise tokenizer. `gpt-tokenizer` is pure-JS (o200k/cl100k BPE),
 * which matches the OpenAI-compatible families Aura routes through (DeepSeek,
 * MiMo, OpenAI). Loaded lazily and defensively: if the package is absent or
 * errors, we silently fall back to the char-ratio estimate so compaction never
 * depends on it being installed.
 */
let encodeFn: ((text: string) => number[]) | null | undefined;
function loadEncoder(): ((text: string) => number[]) | null {
  if (encodeFn !== undefined) return encodeFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('gpt-tokenizer') as { encode?: (t: string) => number[] };
    encodeFn = typeof mod.encode === 'function' ? mod.encode : null;
  } catch {
    encodeFn = null;
  }
  return encodeFn;
}

/** Tokens for a single string: exact via tokenizer, else char-ratio estimate. */
export function countText(text: string): number {
  if (!text) return 0;
  const enc = loadEncoder();
  if (enc) {
    try { return enc(text).length; } catch { /* fall through */ }
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Provider-independent estimate of how many tokens the *next* prompt will
 * carry, measured directly from the system prompt + current history. This is
 * the signal that should drive compaction: it reflects the payload we are
 * about to send, it never lags a turn, and — critically — it does not depend
 * on the provider reporting streamed `usage`, which several OpenAI-compatible
 * endpoints omit on tool-call turns. Do NOT substitute a running sum of
 * per-turn `usage.totalTokens`: each turn's input already contains the entire
 * history, so summing them N-counts the same bytes.
 *
 * Uses the precise tokenizer when available (see loadEncoder), otherwise a
 * conservative char-ratio estimate. Result is identical in shape either way.
 */
export function estimateContextTokens(system: string, history: HistoryMessage[]): number {
  let tokens = countText(system);
  for (const msg of history) tokens += countMessage(msg);
  return tokens;
}

/** Token estimate for a single history message. */
export function countMessage(msg: HistoryMessage): number {
  switch (msg.role) {
    case 'user':
      return countText(msg.content);
    case 'assistant': {
      let tokens = countText(msg.content ?? '');
      for (const call of msg.toolCalls ?? []) {
        tokens += countText(call.name) + countText(JSON.stringify(call.input));
      }
      return tokens;
    }
    case 'tool_result': {
      let tokens = 0;
      for (const r of msg.results) {
        tokens += countText(r.name) + countText(r.content ?? '');
      }
      return tokens;
    }
  }
}

/** Separates the (per-call, regenerated) header/hint/digest lines of a recap
 *  from its accumulated body of per-turn summary lines. Everything after this
 *  marker is append-only across compactions — see extractRecapBodyLines. */
const HISTORY_MARKER = '--- compacted turns ---';

/**
 * Body lines of an existing recap: the accumulated per-turn summaries below
 * HISTORY_MARKER, verbatim. Older recaps written before this marker existed
 * (no marker found) fall back to everything after the header line, so a
 * mid-session upgrade doesn't lose history — but from that point on they
 * gain the marker and become append-only too.
 */
function extractRecapBodyLines(msg: HistoryMessage & { role: 'assistant' }): string[] {
  const lines = msg.content.split('\n');
  const markerIdx = lines.indexOf(HISTORY_MARKER);
  if (markerIdx !== -1) return lines.slice(markerIdx + 1);
  return lines.slice(1).filter(l => l.trim().length > 0);
}

function summariseMessage(msg: HistoryMessage): string {
  switch (msg.role) {
    case 'user':
      return `User: ${msg.content.slice(0, 120)}${msg.content.length > 120 ? '…' : ''}`;
    case 'assistant': {
      const text = msg.content ? `Assistant: ${msg.content.slice(0, 120)}${msg.content.length > 120 ? '…' : ''}` : '';
      const calls = msg.toolCalls?.length ? `Called: ${msg.toolCalls.map(c => c.name).join(', ')}` : '';
      return [text, calls].filter(Boolean).join(' · ') || 'Assistant: (no content)';
    }
    case 'tool_result': {
      const toolNames = msg.results.map(r => r.name).join(', ');
      return `Tool results: [${toolNames}]`;
    }
  }
}

/**
 * Compact conversation history when context usage crosses the escalating
 * LADDER threshold for the current recap generation (see thresholdRatio).
 * Keeps the first message (task) and a recent tail of up to RETENTION_RATIO
 * of the window verbatim; replaces the middle with a recap that can carry an
 * executive digest and tone hint (see extras). If the middle already
 * contains a prior recap, its accumulated body (below HISTORY_MARKER) is
 * carried forward byte-for-byte and only the newly-aged-out turns are
 * appended — the header/hint/digest lines are the only part regenerated
 * each call, so most of the recap's content stays a stable prefix across
 * compactions (helps any cache breakpoint placed after it survive). The new
 * recap's generation increments — once it would exceed
 * ROLLOVER_AT_GENERATION, callers should flush via generational-flush.ts
 * instead of calling this again.
 *
 * Mutates `history` in place (clears and re-fills) so callers that hold a
 * shared reference see the compacted version without reassignment.
 *
 * Returns `true` if compaction happened.
 */
export interface CompactionExtras {
  /** Digest of recent state-altering tool calls (ExecutiveQueue.digest()). */
  executiveDigest?: string;
  /** Advisory tone hint (detectFrustration()). */
  affectHint?: string;
}

/**
 * Index of the first message to keep verbatim: walk backward from the end of
 * `history` accumulating message sizes until the tail would exceed
 * RETENTION_RATIO of the window, then snap to the nearest user-turn start so
 * the kept slice opens with user context and no tool_use/tool_result pair is
 * split. Exported so both the default and tiered compaction strategies size
 * and align their verbatim tail identically (see tiered-context.ts).
 */
export function computeTailBoundary(history: HistoryMessage[], window: number): number {
  const retainBudget = Math.floor(window * RETENTION_RATIO);
  let acc = 0;
  let keepFrom = history.length;
  for (let i = history.length - 1; i >= 1; i--) {
    const cost = countMessage(history[i]);
    if (acc + cost > retainBudget && keepFrom < history.length) break;
    acc += cost;
    keepFrom = i;
  }
  if (keepFrom >= history.length) keepFrom = history.length - 1;

  // Snap the boundary to the start of a user turn when one is nearby, so the
  // kept slice opens with user context and tool_use/tool_result pairs stay
  // intact (a user message never sits between a tool_use and its result).
  let snapped = -1;
  for (let i = keepFrom; i >= Math.max(1, keepFrom - 6); i--) {
    if (history[i].role === 'user') { snapped = i; break; }
  }
  if (snapped !== -1) {
    keepFrom = snapped;
  } else {
    // No user turn nearby (e.g. one long tool-heavy stretch, like the old
    // FALLBACK_KEEP case) — never let the kept slice START with a
    // tool_result whose tool_use was compacted away.
    keepFrom = Math.max(keepFrom, Math.max(1, history.length - FALLBACK_KEEP));
    while (
      keepFrom < history.length - 1 &&
      history[keepFrom].role === 'tool_result'
    ) keepFrom++;
  }
  return keepFrom;
}

export function compactHistory(
  history: HistoryMessage[],
  totalTokens: number,
  model: string,
  extras?: CompactionExtras,
): boolean {
  const generation = getRecapGeneration(history);
  const window = getContextWindow(model) ?? DEFAULT_WINDOW;
  const threshold = Math.floor(window * thresholdRatio(generation));

  if (totalTokens < threshold) return false;
  if (history.length <= 3) return false;

  const keepFrom = computeTailBoundary(history, window);
  const toCompact = history.slice(1, keepFrom);
  if (toCompact.length === 0) {
    // Nothing droppable (the over-budget content IS the recent tail) — the
    // churn guard is the only lever left.
    return truncateOversizedResults(history, threshold);
  }

  // A prior recap (if any) is always the first entry of toCompact — carry its
  // body forward unchanged; only the messages after it are freshly summarised.
  const priorRecap = toCompact.length > 0 && isRecap(toCompact[0]) ? toCompact[0] : undefined;
  const freshlyCompacted = priorRecap ? toCompact.slice(1) : toCompact;
  const priorBodyLines = priorRecap ? extractRecapBodyLines(priorRecap) : [];
  const newBodyLines = freshlyCompacted.map(summariseMessage);
  const bodyLines = [...priorBodyLines, ...newBodyLines];

  const newGeneration = generation + 1;
  const totalRemoved = (priorRecap ? bodyLines.length : toCompact.length);
  const recap: HistoryMessage = {
    role: 'assistant',
    content: [
      `${RECAP_MARKER} (gen ${newGeneration}): ${totalRemoved} turns removed to stay within context limits.]`,
      ...(extras?.affectHint ? [extras.affectHint] : []),
      ...(extras?.executiveDigest ? ['', extras.executiveDigest, ''] : []),
      HISTORY_MARKER,
      ...bodyLines,
    ].join('\n'),
  };

  const preserved = [history[0], recap, ...history.slice(keepFrom)];
  history.length = 0;
  for (const msg of preserved) history.push(msg);

  // Churn guard (see truncateOversizedResults).
  truncateOversizedResults(history, threshold);

  return true;
}

/**
 * Churn guard: a single oversized tool_result in the kept tail can hold the
 * estimate above the trigger forever, so compaction would fire every turn
 * with no shrinkage. If the history is still over threshold, cap result
 * bodies. Returns true if anything was truncated.
 */
function truncateOversizedResults(history: HistoryMessage[], threshold: number): boolean {
  let total = 0;
  for (const msg of history) total += countMessage(msg);
  if (total < threshold) return false;

  let truncated = false;
  for (const msg of history) {
    if (msg.role !== 'tool_result') continue;
    for (const r of msg.results) {
      if (r.content && r.content.length > MAX_RESULT_CHARS) {
        r.content = r.content.slice(0, MAX_RESULT_CHARS) + '\n[truncated during compaction]';
        truncated = true;
      }
    }
  }
  return truncated;
}

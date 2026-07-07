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
 *  window. 40% preserves interaction nuance over long sequences. */
const RETENTION_RATIO = 0.40;
const DEFAULT_WINDOW = 128_000;
/** Messages kept when no later user turn exists to anchor the tail. */
const FALLBACK_KEEP = 3;
/** Per-tool-result cap applied by the churn guard (see compactHistory). */
const MAX_RESULT_CHARS = 4_000;

function thresholdRatio(generation: number): number {
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

/** Generic English + prior-recap boilerplate excluded from term extraction. */
const RECAP_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'it', 'this', 'that', 'with', 'not', 'note', 'recent',
  'user', 'assistant', 'tool', 'results', 'called', 'earlier', 'conversation',
  'compacted', 'turns', 'removed', 'stay', 'within', 'context', 'limits',
]);

/** Top-N most frequent non-stopword tokens across a set of lines. Pure stats,
 *  no LLM — same style as dream.ts's topicKey / mining/extract.ts. */
function extractTopTerms(lines: string[], n: number): string[] {
  const freq = new Map<string, number>();
  for (const line of lines) {
    const words = line.toLowerCase().replace(/[^a-z0-9\s./_-]/g, ' ').split(/\s+/);
    for (const w of words) {
      if (w.length <= 3 || RECAP_STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

/** First non-empty line, truncated to ~8 words — a cheap topic label. */
function extractConcept(lines: string[]): string {
  const first = lines.find(l => l.trim().length > 0)?.trim() ?? '(no content)';
  const words = first.split(/\s+/);
  return words.length > 8 ? words.slice(0, 8).join(' ') + '…' : first;
}

/**
 * Reduce an existing recap to: 1 concept + top 5 terms, plus its LAST body
 * line preserved verbatim ("last thread, pre-compaction"). Replaces
 * summariseMessage's blind slice(0,120) for recap messages specifically —
 * that truncation was destroying the executive digest and prior context on
 * any second compaction in the same run.
 */
function compressRecap(msg: HistoryMessage & { role: 'assistant' }): string {
  const lines = msg.content.split('\n').filter(l => l.trim().length > 0);
  const body = lines.slice(1); // drop the "[Earlier conversation compacted...]" header
  const lastThread = body.length > 0 ? body[body.length - 1] : '';
  const rest = body.slice(0, -1);

  const concept = extractConcept(rest);
  const terms = extractTopTerms(rest, 5);

  return [
    `Concept: ${concept}`,
    terms.length > 0 ? `Terms: ${terms.join(', ')}` : '',
    lastThread ? `Last thread: ${lastThread}` : '',
  ].filter(Boolean).join(' · ');
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
 * contains a prior recap, it's compressed via compressRecap rather than
 * blindly truncated, and the new recap's generation increments — once it
 * would exceed ROLLOVER_AT_GENERATION, callers should flush via
 * generational-flush.ts instead of calling this again.
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

  // Keep-boundary by token budget: walk backward accumulating message sizes
  // until the verbatim tail would exceed RETENTION_RATIO of the window. The
  // last message is always kept even if it alone busts the budget.
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

  const toCompact = history.slice(1, keepFrom);
  if (toCompact.length === 0) {
    // Nothing droppable (the over-budget content IS the recent tail) — the
    // churn guard is the only lever left.
    return truncateOversizedResults(history, threshold);
  }

  const summaries = toCompact.map(msg => isRecap(msg) ? compressRecap(msg) : summariseMessage(msg));
  const newGeneration = generation + 1;
  const recap: HistoryMessage = {
    role: 'assistant',
    content: [
      `${RECAP_MARKER} (gen ${newGeneration}): ${toCompact.length} turns removed to stay within context limits.]`,
      ...(extras?.affectHint ? [extras.affectHint] : []),
      ...(extras?.executiveDigest ? ['', extras.executiveDigest, ''] : []),
      ...summaries,
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

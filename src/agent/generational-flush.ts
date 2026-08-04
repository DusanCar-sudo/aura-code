/**
 * Generational rollover — the "new context window" step. In-place recap
 * compaction (compactor.ts) can only escalate its trigger threshold so far
 * (ROLLOVER_AT_GENERATION) before recompacting a recap starts destroying
 * information no heuristic can recover cheaply. At that point, flush the
 * whole recap through one LLM call — the same distillation primitive the
 * cross-session dream pipeline uses (src/dream/dream.ts) — into the dream
 * store, and replace it with a short pointer. This is "distill, don't
 * discard" applied mid-session instead of only at process exit, and it
 * means the flushed content is automatically picked up by the normal
 * cross-session runReconciliation() pass alongside end-of-session dreams.
 */
import type { HistoryMessage, LLMProvider } from '../providers/types.js';
import { findRecapIndex } from './compactor.js';
import { distillText, sessionFlushFile } from '../dream/dream.js';

const FLUSH_SYSTEM = [
  'You distill an in-progress coding session\'s compacted history into durable memory bullets.',
  'Write ONLY markdown bullet points, one per line, each starting with "- ".',
  'Each bullet must be a concrete, standalone fact: a decision made, a file touched, a root cause found, or an unresolved thread.',
  'Be specific — file names, exact behavior, not generic advice. No headers, no prose paragraphs.',
].join(' ');

/** Per-process counter for sessionFlushFile's uniqueness suffix. */
let flushSeq = 0;

export interface RolloverResult {
  flushed: boolean;
  flushPath?: string;
}

/**
 * Flush the current recap to the dream store and replace it in `history`
 * with a pointer line + a freshly regenerated executive digest and affect
 * hint (never the old recap's text — that's what's being flushed). Mutates
 * `history` in place, matching compactHistory's contract. No-ops if there's
 * no recap to flush.
 */
export async function maybeRollover(
  history: HistoryMessage[],
  sessionRoot: string,
  provider: LLMProvider,
  extras: { executiveDigest?: string; affectHint?: string } = {},
): Promise<RolloverResult> {
  const recapIndex = findRecapIndex(history);
  if (recapIndex === -1) return { flushed: false };

  const recap = history[recapIndex] as HistoryMessage & { role: 'assistant' };
  flushSeq++;
  const flushPath = sessionFlushFile(sessionRoot, flushSeq);

  await distillText({
    systemPrompt: FLUSH_SYSTEM,
    userContent: recap.content,
    provider,
    outPath: flushPath,
  });

  const pointer: HistoryMessage = {
    role: 'assistant',
    content: [
      `[Session context flushed to memory (${flushPath}) — continuing with a fresh context window.]`,
      ...(extras.affectHint ? [extras.affectHint] : []),
      ...(extras.executiveDigest ? ['', extras.executiveDigest] : []),
    ].join('\n'),
  };

  // Note: the pointer's content deliberately does NOT start with compactor's
  // RECAP_MARKER, so getRecapGeneration(history) reads back to 0 next time —
  // this message is ordinary content from here on, not a growing recap.
  history.splice(recapIndex, 1, pointer);

  return { flushed: true, flushPath };
}

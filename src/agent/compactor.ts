import type { HistoryMessage } from '../providers/types.js';
import { getContextWindow } from '../providers/factory.js';

const COMPACTION_THRESHOLD = 0.7;
const PRESERVE_RECENT = 3;
const DEFAULT_WINDOW = 128_000;

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
 * Compact conversation history when context usage crosses ~70% of the model's
 * window. Keeps the first message (task) and the most recent messages
 * verbatim; replaces the middle with a recap.
 *
 * Mutates `history` in place (clears and re-fills) so callers that hold a
 * shared reference see the compacted version without reassignment.
 *
 * Returns `true` if compaction happened.
 */
export function compactHistory(
  history: HistoryMessage[],
  totalTokens: number,
  model: string,
): boolean {
  const window = getContextWindow(model) ?? DEFAULT_WINDOW;
  const threshold = Math.floor(window * COMPACTION_THRESHOLD);

  if (totalTokens < threshold) return false;

  const MIN_KEEP = 2 + PRESERVE_RECENT;
  if (history.length <= MIN_KEEP) return false;

  // Prefer preserving the ENTIRE most recent user turn intact — search
  // backward for the last 'user' message (excluding the original task at
  // index 0). A forward-only search from an arbitrary message-count
  // boundary can miss this entirely, since the most recent user turn may
  // start well before that boundary — confirmed by testing a multi-turn
  // session where a forward search found nothing and fell through to
  // collapsing the whole session, discarding a real, recent instruction.
  let keepFrom = -1;
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'user') { keepFrom = i; break; }
  }

  if (keepFrom === -1) {
    // No later user turn exists (e.g. still mid-task, only the original
    // instruction so far) — fall back to keeping roughly the last
    // PRESERVE_RECENT messages, walked forward to avoid landing on an
    // orphaned tool_result or directly after the assistant-role recap.
    keepFrom = Math.max(1, history.length - PRESERVE_RECENT);
    while (
      keepFrom < history.length &&
      (history[keepFrom].role === 'tool_result' || history[keepFrom].role === 'assistant')
    ) keepFrom++;
  }

  const toCompact = history.slice(1, keepFrom);

  if (toCompact.length === 0) return false;

  const summaries = toCompact.map(summariseMessage);
  const recap: HistoryMessage = {
    role: 'assistant',
    content: [
      `[Earlier conversation compacted: ${toCompact.length} turns removed to stay within context limits.]`,
      ...summaries,
    ].join('\n'),
  };

  const preserved = [history[0], recap, ...history.slice(keepFrom)];
  history.length = 0;
  for (const msg of preserved) history.push(msg);

  return true;
}

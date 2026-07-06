/**
 * Lightweight affect heuristic — integrated into the loop, not a standalone
 * NLU module. A lexical scan of recent user messages; when it detects
 * frustration it returns one advisory line for the compaction recap.
 * No LLM call; false positives cost a single recap line.
 */
import type { HistoryMessage } from '../providers/types.js';

// Seeded from the dream reconciler's NEGATIVE_WORDS plus frustration-specific
// terms. Kept local: the agent core must not depend on src/dream/.
const FRUSTRATION_WORDS = [
  'broken', 'fails', 'failing', 'wrong', 'bug', 'error', 'not working',
  "doesn't work", 'never works', 'stop doing', 'again!!', 'still broken',
  'still not', 'why does', 'why is this', 'frustrat', 'annoying', 'useless',
  'wtf', 'terrible',
];

function hits(text: string): number {
  const t = text.toLowerCase();
  return FRUSTRATION_WORDS.reduce((n, w) => (t.includes(w) ? n + 1 : n), 0);
}

/**
 * Scan the last `lookback` user messages. Requires ≥2 total hits, or ≥1 in
 * the very last user message, so ordinary bug-fixing vocabulary ("fix this
 * error") doesn't trip it. Returns an advisory line or null.
 */
export function detectFrustration(history: HistoryMessage[], lookback = 3): string | null {
  const userMessages = history.filter(m => m.role === 'user').slice(-lookback);
  if (userMessages.length === 0) return null;

  let total = 0;
  for (const m of userMessages) total += hits(m.content);
  const lastHit = hits(userMessages[userMessages.length - 1].content) > 0;

  if (total >= 2 || lastHit) {
    return 'Note: recent user messages show signs of frustration — prioritize directness, verify before claiming success.';
  }
  return null;
}

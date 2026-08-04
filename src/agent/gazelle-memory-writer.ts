import * as fs from 'fs';
import type { HistoryMessage } from '../providers/types.js';
import { createProvider } from '../providers/factory.js';
import { resolveSummaryModel } from './tiered-context.js';
import { CONVERSATIONAL_FILE } from './unified-memory.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle conversational-memory writer — session-end only, one write.
//
// Maintains ~/.aura/memory/conversational.md: a short prose *situation* (where
// things stand with Dušan), NOT a running log of topics. It runs once at the
// end of a Gazelle session, does a single cheap-model rewrite of the previous
// situation given what just happened, and overwrites the file wholesale so
// stale situations fall away instead of accumulating.
//
// Cheap by construction: one call per session, on the tiered-context summary
// model (deepseek-v4-flash when DEEPSEEK_API_KEY is set), never per turn.
// ─────────────────────────────────────────────────────────────────────────────

/** Max chars we keep from the just-ended conversation when prompting. */
const HISTORY_BUDGET = 2000;
/** Hard ceiling on what we write, matching the read-side conversational cap. */
const MAX_WRITE_CHARS = 600;

const REWRITE_SYSTEM =
  'You maintain a one-paragraph "situation" note about Dušan for a warm ' +
  'conversational assistant. Given the previous situation and the conversation ' +
  'that just happened, write an updated 2-4 sentence summary of what is TRUE NOW ' +
  '— what he is mid-flight on, and how he is feeling about it if relevant. Not a ' +
  'list of topics, not what was said, not meeting minutes. If the previous ' +
  'situation is now stale or resolved, drop it. Keep it under 500 characters. ' +
  'Write it the way a friend would answer "what\'s Dušan up to lately." ' +
  'Output only the paragraph, no preamble or quotes.';

/** Flatten Gazelle history (user/assistant only) into a readable transcript,
 *  keeping the most recent HISTORY_BUDGET chars. */
function transcript(history: HistoryMessage[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role === 'user') lines.push(`Dušan: ${m.content}`);
    else if (m.role === 'assistant' && m.content) lines.push(`Aura: ${m.content}`);
  }
  const full = lines.join('\n');
  return full.length > HISTORY_BUDGET ? '…' + full.slice(-HISTORY_BUDGET) : full;
}

/**
 * Rewrite conversational.md from the just-ended session. Best-effort: on any
 * failure (network, empty completion, write error) the existing file is left
 * untouched — a good situation is never overwritten with a broken one.
 *
 * @param history   the conversation that just happened
 * @param mainModel the session's model, used only to resolve the summary model
 */
export async function writeConversationalMemory(
  history: HistoryMessage[],
  mainModel = 'deepseek/deepseek-v4-flash',
): Promise<void> {
  try {
    const convo = transcript(history);
    if (!convo.trim()) return;

    let previous = 'none yet';
    try {
      const existing = fs.readFileSync(CONVERSATIONAL_FILE, 'utf8').trim();
      if (existing) previous = existing;
    } catch { /* first session — no file yet */ }

    const provider = createProvider({ model: resolveSummaryModel(mainModel) });
    const userMsg =
      `Previous situation: ${previous}\n\n` +
      `This conversation just happened:\n${convo}`;
    const res = await provider.complete(REWRITE_SYSTEM, [{ role: 'user', content: userMsg }], []);

    const next = (res.text ?? '').trim();
    if (!next) return; // empty completion — keep the good file

    const clipped = next.length > MAX_WRITE_CHARS
      ? next.slice(0, MAX_WRITE_CHARS).replace(/\s+\S*$/, '').trimEnd()
      : next;
    fs.writeFileSync(CONVERSATIONAL_FILE, clipped + '\n', 'utf8');
  } catch (e) {
    // Quiet: memory is a nice-to-have, never a reason to fail session exit.
    if (process.env.AURA_GAZELLE_DEBUG) {
      console.error('[gazelle] conversational memory write failed:', String(e));
    }
  }
}

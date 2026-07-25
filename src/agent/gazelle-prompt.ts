import type { GazelleMemory } from './unified-memory.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle prompt — the whole conversational system prompt.
//
// This is the entire point of Gazelle mode: a warm, tool-less prompt that lands
// around 300–400 tokens INCLUDING memory, versus the ~4 KB tool schema + full
// project context the coding path pays every turn. Keep it small. If you're
// tempted to add a section, ask whether a person who knows Dušan would say it.
// ─────────────────────────────────────────────────────────────────────────────

/** Used when identity.json is empty (fresh machine / pre-migration). Warm and
 *  curated rather than a raw fact dump — see the memory injection below. */
const FALLBACK_IDENTITY =
  'Dušan: Da Nang (UTC+7), builds aura-code and Lean Progress IQ, Serbian, ' +
  'teaches English online, trains fitness.';

/** Current wall-clock in Dušan's timezone (UTC+7, no DST) as `YYYY-MM-DD HH:MM`. */
function nowInDaNang(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return shifted.toISOString().replace('T', ' ').slice(0, 16) + ' (UTC+7)';
}

/**
 * Build the Gazelle conversational system prompt from the lean memory block.
 *
 * `memory.identity` (from identity.json) is the "who you're talking with" line,
 * with FALLBACK_IDENTITY as the safety net. `memory.conversational` (the rolling
 * situational summary) is injected as PLAIN PROSE — never under a `## Memory`
 * heading. A person who knows you doesn't preface a chat with a dossier; when
 * there's no situational summary yet, the line is simply omitted.
 */
export function buildGazellePrompt(memory: GazelleMemory): string {
  const who = memory.identity || FALLBACK_IDENTITY;

  const lines: string[] = [
    'You are Aura in conversation — quick, warm, direct.',
    '',
    `You're talking with ${who}`,
  ];

  if (memory.conversational) {
    lines.push('', memory.conversational);
  }

  lines.push(
    '',
    'How you talk:',
    '- Answer immediately. No "I\'ll help you with that" preamble.',
    '- Keep it short — a few sentences unless he asks for depth.',
    "- You know him. Don't announce what you remember, just use it.",
    '- Ask real questions when you\'re curious. Not "let me know if you need anything else."',
    '- Warm, not gushing. Direct, not curt.',
    '',
    'You have no tools in this mode. If something genuinely needs reading files,',
    'running commands, or editing code, say so plainly and offer to switch (:coder).',
    '',
    `Current time: ${nowInDaNang()}`,
  );

  const prompt = lines.join('\n');
  if (process.env.AURA_GAZELLE_DEBUG) {
    console.error('[gazelle] prompt chars:', prompt.length);
  }
  return prompt;
}

// Audio-reply policy for the Telegram bot — pure helpers, no I/O.
// Lives outside telegram-bot.ts (which starts live polling at import time)
// so the decision logic is unit-testable, same as telegram-safety.ts.

/**
 * When to attach a voice note to a reply:
 *  - 'off'        — never
 *  - 'voice-only' — only when the user's message came in as voice (the
 *                   original behavior: speak back to whoever spoke)
 *  - 'auto'       — voice-in replies + any substantial conversational reply
 *                   (length ≥ minChars). The default: text always, audio for
 *                   task summaries worth listening to, silence for short acks.
 *  - 'always'     — every conversational reply
 *
 * Command output (/help, /run, /ls …) is never spoken regardless of mode —
 * only conversational replies from the LLM, plus the voice-in echo path.
 */
export type AudioReplyMode = 'off' | 'voice-only' | 'auto' | 'always';

export const DEFAULT_AUDIO_MIN_CHARS = 500;

export function normalizeAudioMode(raw: unknown): AudioReplyMode {
  const v = String(raw ?? '').toLowerCase().trim();
  if (v === 'off' || v === 'voice-only' || v === 'always' || v === 'auto') return v;
  return 'auto';
}

export function shouldSendAudio(opts: {
  mode: AudioReplyMode;
  cameFromVoice: boolean;
  conversational: boolean;
  length: number;
  minChars?: number;
}): boolean {
  const { mode, cameFromVoice, conversational, length } = opts;
  const minChars = opts.minChars ?? DEFAULT_AUDIO_MIN_CHARS;
  if (mode === 'off') return false;
  if (cameFromVoice) return true; // spoke to her → she speaks back
  if (!conversational) return false; // never read /help or shell output aloud
  if (mode === 'voice-only') return false;
  if (mode === 'always') return true;
  return length >= minChars; // 'auto'
}

/**
 * Prepare text for TTS — same treatment as the CLI's speakSummary: drop code
 * blocks and markdown noise, collapse whitespace, cap the length so a long
 * report doesn't monologue (the full text is always still sent as a regular
 * message alongside the voice note).
 */
export function stripForSpeech(text: string, maxChars = 1200): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`[^`]*`/g, '')
    .replace(/[#*_>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

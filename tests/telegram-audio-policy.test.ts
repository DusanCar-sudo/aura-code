import { describe, it, expect } from 'vitest';
import {
  normalizeAudioMode, shouldSendAudio, stripForSpeech, DEFAULT_AUDIO_MIN_CHARS,
} from '../src/tools/telegram-audio-policy.js';

describe('normalizeAudioMode', () => {
  it('accepts the four valid modes', () => {
    expect(normalizeAudioMode('off')).toBe('off');
    expect(normalizeAudioMode('voice-only')).toBe('voice-only');
    expect(normalizeAudioMode('auto')).toBe('auto');
    expect(normalizeAudioMode('always')).toBe('always');
  });
  it('is case/whitespace tolerant', () => {
    expect(normalizeAudioMode('  OFF ')).toBe('off');
    expect(normalizeAudioMode('Always')).toBe('always');
  });
  it('defaults to auto for missing or unknown values', () => {
    expect(normalizeAudioMode(undefined)).toBe('auto');
    expect(normalizeAudioMode(null)).toBe('auto');
    expect(normalizeAudioMode('loud')).toBe('auto');
    expect(normalizeAudioMode(42)).toBe('auto');
  });
});

describe('shouldSendAudio', () => {
  const base = { cameFromVoice: false, conversational: true, length: 100 };

  it("'off' never sends audio, even for voice-in", () => {
    expect(shouldSendAudio({ ...base, mode: 'off' })).toBe(false);
    expect(shouldSendAudio({ ...base, mode: 'off', cameFromVoice: true })).toBe(false);
    expect(shouldSendAudio({ ...base, mode: 'off', length: 10_000 })).toBe(false);
  });

  it('voice-in always speaks back (unless off)', () => {
    expect(shouldSendAudio({ ...base, mode: 'voice-only', cameFromVoice: true })).toBe(true);
    expect(shouldSendAudio({ ...base, mode: 'auto', cameFromVoice: true, length: 5 })).toBe(true);
    expect(shouldSendAudio({ ...base, mode: 'always', cameFromVoice: true })).toBe(true);
  });

  it('command output is never spoken (non-conversational), except voice-in echo', () => {
    for (const mode of ['voice-only', 'auto', 'always'] as const) {
      expect(shouldSendAudio({ mode, cameFromVoice: false, conversational: false, length: 10_000 })).toBe(false);
    }
    expect(shouldSendAudio({ mode: 'auto', cameFromVoice: true, conversational: false, length: 10 })).toBe(true);
  });

  it("'voice-only' stays silent for typed messages", () => {
    expect(shouldSendAudio({ ...base, mode: 'voice-only', length: 10_000 })).toBe(false);
  });

  it("'auto' speaks only substantial replies (>= minChars)", () => {
    expect(shouldSendAudio({ ...base, mode: 'auto', length: DEFAULT_AUDIO_MIN_CHARS - 1 })).toBe(false);
    expect(shouldSendAudio({ ...base, mode: 'auto', length: DEFAULT_AUDIO_MIN_CHARS })).toBe(true);
    expect(shouldSendAudio({ ...base, mode: 'auto', length: 30, minChars: 20 })).toBe(true);
    expect(shouldSendAudio({ ...base, mode: 'auto', length: 30, minChars: 40 })).toBe(false);
  });

  it("'always' speaks every conversational reply", () => {
    expect(shouldSendAudio({ ...base, mode: 'always', length: 1 })).toBe(true);
  });
});

describe('stripForSpeech', () => {
  it('drops fenced code blocks', () => {
    const s = stripForSpeech('Done.\n```js\nconst x = 1;\n```\nAll tests pass.');
    expect(s).toContain('Done.');
    expect(s).toContain('(code omitted)');
    expect(s).toContain('All tests pass.');
    expect(s).not.toContain('const x');
  });

  it('drops inline code and markdown markers, collapses whitespace', () => {
    const s = stripForSpeech('## Result\n\n*Fixed* the `parseFoo()` bug   now.');
    expect(s).not.toContain('#');
    expect(s).not.toContain('*');
    expect(s).not.toContain('parseFoo');
    expect(s).toBe('Result Fixed the bug now.');
  });

  it('caps length', () => {
    expect(stripForSpeech('x'.repeat(5000)).length).toBe(1200);
    expect(stripForSpeech('x'.repeat(5000), 100).length).toBe(100);
  });

  it('handles empty input', () => {
    expect(stripForSpeech('')).toBe('');
    expect(stripForSpeech('```\nonly code\n```')).toBe('(code omitted)');
  });
});

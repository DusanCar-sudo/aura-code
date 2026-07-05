#!/usr/bin/env node
import chalk from 'chalk';
import { dictate, speakText, listVoices, listDevices, dictationLoop, toggleDictation } from '../tools/dictate.js';
import minimist from 'minimist';

// ─────────────────────────────────────────────────────────────────────────────
// dic — standalone dictation command
// Usage:
//   dic                 Record mic → transcribe (Ctrl+C to stop)
//   dic speak <text>    Speak text aloud via MiMo TTS
//   dic devices         List available audio input devices
//   dic voices          List available MiMo TTS voices
//   dic --device <name> Use a specific audio input device
// ─────────────────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const parsed = minimist(rawArgs);
const sub = parsed._[0];

if (sub === 'toggle') {
  // One-hotkey dictation: 1st press starts recording, 2nd press stops +
  // transcribes + types into the focused window (with Enter). Built for a
  // global shortcut (e.g. KDE Super+Space bound to `dic toggle`).
  const deviceId = parsed.device || undefined;
  const submit = parsed.submit !== false && !parsed['no-submit'];
  toggleDictation({ deviceId, submit }).catch(e => {
    console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`));
    process.exit(1);
  });

} else if (sub === 'devices' || sub === 'device') {
  listDevices();

} else if (sub === 'speak') {
  const voice = parsed.voice || undefined;
  const textParts = parsed._.slice(1);
  const text = textParts.join(' ').trim();
  if (!text) {
    console.error(chalk.hex('#b15439')('Usage: dic speak <text> [--voice <id>]\n'));
    process.exit(1);
  }
  speakText(text, voice).catch(e => {
    console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`));
    process.exit(1);
  });

} else if (sub === 'voices') {
  listVoices();

} else if (sub === 'help' || parsed.help || parsed.h) {
  console.log(`
  ${chalk.hex('#cc785c').bold('dic')} ${chalk.hex('#8a7768')('— speech-to-text & text-to-speech')}

  ${chalk.hex('#4e3d30')('Usage:')}
    ${chalk.hex('#8a7768')('dic')}                               Record → transcribe → copy + type into focused window
    ${chalk.hex('#8a7768')('dic --no-inject')}                   Record → transcribe → clipboard only (no typing)
    ${chalk.hex('#8a7768')('dic toggle')}                        Hotkey mode: 1st press records, 2nd press sends (types + Enter)
    ${chalk.hex('#8a7768')('dic toggle --no-submit')}            Toggle, but don't press Enter after typing
    ${chalk.hex('#8a7768')('dic loop')}                          Continuous: speak → type → repeat (Ctrl+C to stop)
    ${chalk.hex('#8a7768')('dic loop --silence 2000')}           Continuous with custom silence threshold (ms)
    ${chalk.hex('#8a7768')('dic --device <name>')}               Record with a specific audio device
    ${chalk.hex('#8a7768')('dic devices')}                       List available audio input devices
    ${chalk.hex('#8a7768')('dic speak <text>')}                  Speak text aloud via MiMo TTS
    ${chalk.hex('#8a7768')('dic speak <text> --voice Chloe')}    Speak with a specific voice
    ${chalk.hex('#8a7768')('dic voices')}                        List available TTS voices

  ${chalk.hex('#4e3d30')('API keys:')}
    PARAKEET_BASE_URL Local NVIDIA Parakeet ASR (self-hosted, no key)
    XIAOMI_API_KEY    MiMo ASR (STT) + MiMo TTS — free tier available
    OPENAI_API_KEY    OpenAI Whisper (STT fallback)
    GROQ_API_KEY      Groq Whisper (STT fallback, very fast)

  ${chalk.hex('#4e3d30')('Notes:')}
    - STT prioritizes PARAKEET_BASE_URL > XIAOMI_API_KEY > OPENAI_API_KEY > GROQ_API_KEY
    - TTS requires XIAOMI_API_KEY (limited-time free)
    - Transcriptions are automatically copied to clipboard
    - Injection (typing into the focused window) is ON by default; use --no-inject to disable
    - KDE/KWin Wayland rejects wtype — install ydotool and enable ydotoold for typing there
    - 'dic loop' runs continuous dictation with auto-injection
    - 'dic toggle' is meant for a global shortcut (e.g. KDE Super+Space → dic toggle)
    - Press Ctrl+C to stop recording
\n`);

} else if (sub === 'loop' || parsed.loop || parsed.l) {
  // Continuous dictation loop
  const deviceId = parsed.device || undefined;
  const silenceMs = parsed.silence ? Number(parsed.silence) : 1500;
  dictationLoop({ deviceId, silenceMs }).catch(e => {
    console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`));
    process.exit(1);
  });

} else {
  // Default: dictate. Injection is ON by default (transcription is typed into
  // the focused window when it finishes); --no-inject gives clipboard-only.
  const deviceId = parsed.device || undefined;
  const inject = parsed.inject !== false && !parsed['clip-only'];
  dictate({ deviceId, inject }).catch(e => {
    console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`));
    process.exit(1);
  });
}

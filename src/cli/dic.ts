#!/usr/bin/env node
import chalk from 'chalk';
import { dictate, speakText, listVoices, listDevices } from '../tools/dictate.js';
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

if (sub === 'devices' || sub === 'device') {
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
    ${chalk.hex('#8a7768')('dic')}                               Record mic → transcribe (Ctrl+C to stop)
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
    - Press Ctrl+C to stop recording
\n`);

} else {
  // Default: dictate, optionally with --device
  const deviceId = parsed.device || undefined;
  dictate(deviceId).catch(e => {
    console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`));
    process.exit(1);
  });
}

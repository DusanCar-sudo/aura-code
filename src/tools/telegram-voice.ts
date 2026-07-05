// ─────────────────────────────────────────────────────────────────────────────
// Telegram voice messages — download, transcribe, synthesize, send
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately separate from telegram-bot.ts, which starts a real polling
// loop unconditionally at module scope — importing that file directly (even
// just to test these helpers) would start live polling against Telegram's
// real API. This module has no side effects at import time, so it's safe
// to import directly in tests.
//
// All network calls shell out to the real `curl` binary, matching the exact
// pattern already proven reliable everywhere else in telegram-bot.ts
// (curlPost/curlGet). This is deliberate, not stylistic: Node's native
// fetch was tried first here and failed with ETIMEDOUT/ENETUNREACH on the
// deployed machine — a known class of issue where Node's dual-stack
// "Happy Eyeballs" connection racing breaks on networks where IPv6 is
// advertised but not actually routable. `curl` does not hit the same
// failure on the same machine, so it's the safe choice here, not just a
// style preference.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getApiKey } from '../util/env.js';

const execAsync = promisify(exec);
const VOICE_TTS_CHAR_LIMIT = 800; // conservative cap; full text always still sent separately as a regular message

/** Shell-escapes a string for safe embedding inside single quotes in a curl command. */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/** Downloads a Telegram-hosted file (by file_id) to a local temp path. */
export async function downloadTelegramFile(token: string, fileId: string): Promise<string> {
  const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const { stdout: getFileOut } = await execAsync(`curl -s "${getFileUrl}"`, { timeout: 30_000 });

  let parsed: any;
  try {
    parsed = JSON.parse(getFileOut);
  } catch {
    throw new Error(`getFile returned non-JSON response: ${getFileOut.slice(0, 200)}`);
  }
  if (!parsed.ok) {
    throw new Error(`Telegram getFile error: ${parsed.description} (${parsed.error_code})`);
  }
  const filePath = parsed.result?.file_path;
  if (!filePath) throw new Error('getFile did not return a file_path');

  // Telegram voice messages report a file_path ending in .oga internally,
  // but Groq's Whisper API rejects that extension outright (even though
  // the actual content is genuine Ogg/Opus audio it does accept under
  // .ogg/.opus) — confirmed directly: "file must be one of the following
  // types: [flac mp3 mp4 mpeg mpga m4a ogg opus wav webm]". Since this
  // function is currently only ever used for voice messages, always
  // labeling the local copy .ogg sidesteps that extension-based rejection
  // without touching the actual bytes at all. Revisit if this function
  // ever gets reused for non-voice file downloads.
  const localPath = path.join(os.tmpdir(), `tg-voice-${randomUUID()}.ogg`);
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

  await execAsync(`curl -s -o "${localPath}" "${fileUrl}"`, { timeout: 60_000 });
  if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
    throw new Error('Downloaded voice file is missing or empty');
  }
  return localPath;
}

/**
 * Calls Groq's text-to-speech endpoint and returns raw audio bytes.
 * Requests 'ogg' specifically — that's the one format both Groq supports
 * as a response_format AND Telegram's sendVoice expects natively for the
 * round voice-bubble UI, so no local transcoding/ffmpeg step is needed.
 */
export async function textToSpeech(text: string, apiKey: string): Promise<Buffer> {
  const truncated = text.length > VOICE_TTS_CHAR_LIMIT
    ? text.slice(0, VOICE_TTS_CHAR_LIMIT) + '... see full message above for the rest.'
    : text;

  const body = JSON.stringify({
    model: 'playai-tts',
    voice: 'Fritz-PlayAI',
    input: truncated,
    response_format: 'ogg',
  });

  const outPath = path.join(os.tmpdir(), `tts-out-${randomUUID()}.ogg`);
  const errPath = path.join(os.tmpdir(), `tts-err-${randomUUID()}.json`);
  try {
    // -f makes curl exit non-zero on an HTTP error instead of writing the
    // error body to outPath as if it were audio; capture that error body
    // separately via -o on failure so the real message can still surface.
    await execAsync(
      `curl -sS -f -X POST ` +
      `-H "Authorization: Bearer ${apiKey}" ` +
      `-H "Content-Type: application/json" ` +
      `-d '${shellEscape(body)}' ` +
      `-o "${outPath}" "https://api.groq.com/openai/v1/audio/speech"`,
      { timeout: 60_000 },
    );
  } catch (e: any) {
    // Re-run without -f to capture the actual error body for a useful message.
    try {
      await execAsync(
        `curl -sS -X POST -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" ` +
        `-d '${shellEscape(body)}' -o "${errPath}" "https://api.groq.com/openai/v1/audio/speech"`,
        { timeout: 60_000 },
      );
      const errBody = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
      throw new Error(`Groq TTS API error: ${errBody.slice(0, 500)}`);
    } finally {
      fs.rm(errPath, () => {});
    }
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('Groq TTS returned an empty response');
  }
  const audio = fs.readFileSync(outPath);
  fs.rm(outPath, () => {});
  return audio;
}

/** Sends a voice reply (ogg/opus audio) to a chat via Telegram's sendVoice. */
export async function sendVoiceMessage(token: string, chatId: string | number, audioBuffer: Buffer): Promise<void> {
  const tempPath = path.join(os.tmpdir(), `voice-reply-${randomUUID()}.ogg`);
  fs.writeFileSync(tempPath, audioBuffer);
  try {
    const url = `https://api.telegram.org/bot${token}/sendVoice`;
    const { stdout } = await execAsync(
      `curl -s -X POST -F "chat_id=${String(chatId)}" -F "voice=@${tempPath}" "${url}"`,
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      throw new Error(`sendVoice failed: ${parsed.description} (${parsed.error_code})`);
    }
  } finally {
    fs.rm(tempPath, () => {});
  }
}

/**
 * Downloads a voice message, transcribes it via Groq Whisper, and returns
 * the raw transcribed text — ready to feed straight into the same pipeline
 * that handles typed text. Throws on any failure; caller decides how to
 * report that back to the chat.
 *
 * Deliberately has its own curl-based Whisper call rather than reusing
 * audio-transcribe.ts's callGroqWhisper (which uses native fetch) — keeps
 * the bot's voice pipeline fully insulated from the fetch issue above.
 */
export async function transcribeVoiceMessage(token: string, fileId: string): Promise<string> {
  const groqKey = getApiKey('GROQ_API_KEY', 'groq_api_key');
  if (!groqKey) {
    throw new Error('GROQ_API_KEY not set — voice messages need it for transcription.');
  }
  const localPath = await downloadTelegramFile(token, fileId);
  const outPath = path.join(os.tmpdir(), `whisper-out-${randomUUID()}.json`);
  try {
    await execAsync(
      `curl -sS -X POST -H "Authorization: Bearer ${groqKey}" ` +
      `-F "file=@${localPath}" -F "model=whisper-large-v3-turbo" -F "response_format=verbose_json" ` +
      `-o "${outPath}" "https://api.groq.com/openai/v1/audio/transcriptions"`,
      { timeout: 120_000 },
    );
    if (!fs.existsSync(outPath)) throw new Error('Whisper API returned no response');
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (parsed.error) throw new Error(`Groq Whisper API error: ${JSON.stringify(parsed.error)}`);
    if (typeof parsed.text !== 'string') throw new Error(`Unexpected Whisper response: ${JSON.stringify(parsed).slice(0, 300)}`);
    return parsed.text.trim();
  } finally {
    fs.rm(localPath, () => {});
    fs.rm(outPath, () => {});
  }
}

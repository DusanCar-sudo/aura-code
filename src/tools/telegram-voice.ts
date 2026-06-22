// ─────────────────────────────────────────────────────────────────────────────
// Telegram voice messages — download, transcribe, synthesize, send
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately separate from telegram-bot.ts, which starts a real polling
// loop unconditionally at module scope — importing that file directly (even
// just to test these helpers) would start live polling against Telegram's
// real API. This module has no side effects at import time, so it's safe
// to import directly in tests.
//
// Uses native fetch + FormData throughout, not telegram-bot.ts's curlPost
// shell-curl pattern — these calls move binary audio data, and Blob+FormData
// avoids shell-escaping binary content through a command line entirely.
// Same approach already proven in audio-transcribe.ts's Groq call.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getApiKey } from '../util/env.js';
import { callGroqWhisper } from './audio-transcribe.js';

const VOICE_TTS_CHAR_LIMIT = 800; // conservative cap; full text always still sent separately as a regular message

/** Downloads a Telegram-hosted file (by file_id) to a local temp path. */
export async function downloadTelegramFile(token: string, fileId: string): Promise<string> {
  const getFileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!getFileRes.ok) throw new Error(`getFile failed: ${getFileRes.status}`);
  const getFileJson = await getFileRes.json() as { ok: boolean; result?: { file_path?: string } };
  const filePath = getFileJson.result?.file_path;
  if (!filePath) throw new Error('getFile did not return a file_path');

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Failed to download Telegram file: ${res.status}`);

  const ext = path.extname(filePath) || '.ogg';
  const localPath = path.join(os.tmpdir(), `tg-voice-${fileId}${ext}`);
  fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
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

  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'playai-tts',
      voice: 'Fritz-PlayAI',
      input: truncated,
      response_format: 'ogg',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq TTS API returned ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Sends a voice reply (ogg/opus audio) to a chat via Telegram's sendVoice. */
export async function sendVoiceMessage(token: string, chatId: string | number, audioBuffer: Buffer): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('voice', new Blob([audioBuffer], { type: 'audio/ogg' }), 'reply.ogg');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendVoice failed: ${res.status}: ${body}`);
  }
}

/**
 * Downloads a voice message, transcribes it via Groq Whisper, and returns
 * the raw transcribed text — ready to feed straight into the same pipeline
 * that handles typed text. Throws on any failure; caller decides how to
 * report that back to the chat.
 */
export async function transcribeVoiceMessage(token: string, fileId: string): Promise<string> {
  const groqKey = getApiKey('GROQ_API_KEY', 'groq_api_key');
  if (!groqKey) {
    throw new Error('GROQ_API_KEY not set — voice messages need it for transcription.');
  }
  const localPath = await downloadTelegramFile(token, fileId);
  try {
    const result = await callGroqWhisper(localPath, groqKey);
    return result.text.trim();
  } finally {
    fs.rm(localPath, () => {}); // best-effort cleanup, don't block on it
  }
}

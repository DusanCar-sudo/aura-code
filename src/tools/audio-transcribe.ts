import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../providers/types.js';
import { getApiKey } from '../util/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Audio Transcribe — transcribe audio files using Groq Whisper API
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioTranscribeInput {
  path: string;
  language?: string;
  action?: 'transcribe' | 'info';
}

export const AUDIO_TRANSCRIBE_DEFINITION: ToolDefinition = {
  name: 'audio_transcribe',
  description:
    'Transcribe audio files to text using Groq Whisper API. ' +
    'Supports mp3, mp4, mpeg, mpga, m4a, wav, webm. ' +
    'Requires GROQ_API_KEY environment variable. ' +
    'Actions: transcribe (default, returns text), info (file metadata).',
  parameters: {
    type: 'object',
    properties: {
      path:     { type: 'string', description: 'Path to the audio file' },
      language: { type: 'string', description: 'ISO 639-1 language code (e.g. "en", "sr", "auto" for auto-detect). Default: auto-detect.' },
      action:   { type: 'string', description: 'Action: transcribe (default) or info' },
    },
    required: ['path'],
  },
};

const AUDIO_EXTENSIONS = [
  '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac',
];

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

function getAudioInfo(filePath: string): string {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  const sizeKB = (stat.size / 1024).toFixed(1);

  return [
    `File: ${filePath}`,
    `Size: ${sizeMB} MB (${sizeKB} KB)`,
    `Format: ${ext.slice(1).toUpperCase()}`,
    `Modified: ${stat.mtime.toISOString()}`,
    `Model: ${WHISPER_MODEL} (via Groq)`,
  ].join('\n');
}

export interface GroqWhisperResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
}

/**
 * Calls Groq's Whisper transcription API directly and returns the parsed
 * result — no formatting, no file validation beyond what's needed to build
 * the request. Used by audioTranscribe() below (which wraps this with the
 * rich report format / error-string convention tools use), and by the
 * Telegram bot's voice-message handler (which just wants the raw text to
 * use directly as a task description, not a formatted report about it).
 * Throws on any failure — callers decide how to present that.
 */
export async function callGroqWhisper(
  filePath: string,
  apiKey: string,
  language?: string,
): Promise<GroqWhisperResult> {
  const stat = fs.statSync(filePath);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > 25) {
    throw new Error(`Audio file is ${sizeMB.toFixed(1)} MB, Groq limit is 25 MB. Compress or split the file first.`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: `audio/${ext.slice(1) || 'ogg'}` });

  const formData = new FormData();
  formData.append('file', blob, path.basename(filePath));
  formData.append('model', WHISPER_MODEL);
  if (language && language !== 'auto') {
    formData.append('language', language);
  }
  formData.append('response_format', 'verbose_json');

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Groq API returned ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<GroqWhisperResult>;
}

export async function audioTranscribe(input: AudioTranscribeInput): Promise<string> {
  const filePath = path.resolve(input.path);

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${input.path}`;
  }

  const ext = path.extname(filePath).toLowerCase();
  const action = input.action ?? 'transcribe';

  if (action === 'info') {
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      return `Error: Not an audio file (${ext}). Supported: ${AUDIO_EXTENSIONS.join(', ')}`;
    }
    return getAudioInfo(filePath);
  }

  // transcribe action
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    return `Error: Not an audio file (${ext}). Supported: ${AUDIO_EXTENSIONS.join(', ')}`;
  }

  const apiKey = getApiKey('GROQ_API_KEY', 'groq_api_key');
  if (!apiKey) {
    return 'Error: GROQ_API_KEY not set. Get a free key at https://console.groq.com/keys and set it: export GROQ_API_KEY=gsk_...';
  }

  try {
    const result = await callGroqWhisper(filePath, apiKey, input.language);

    const lines: string[] = [];
    lines.push(`Transcription (${WHISPER_MODEL}):`);
    if (result.language) lines.push(`Language: ${result.language}`);
    if (result.duration) lines.push(`Duration: ${result.duration.toFixed(1)}s`);
    lines.push('');
    lines.push(result.text.trim());

    if (result.segments && result.segments.length > 0) {
      lines.push('');
      lines.push('--- Timestamped segments ---');
      for (const seg of result.segments) {
        const start = formatTimestamp(seg.start);
        const end = formatTimestamp(seg.end);
        lines.push(`[${start} → ${end}] ${seg.text.trim()}`);
      }
    }

    return lines.join('\n');
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return 'Error: Groq API request timed out after 120s. File may be too large.';
    }
    return `Error: ${e?.message ?? String(e)}`;
  }
}

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs — TTS, STT, and voice management
// ─────────────────────────────────────────────────────────────────────────────
// API docs: https://elevenlabs.io/docs/api-reference
// Auth: `xi-api-key` header on every request.
//
// TTS:  POST /v1/text-to-speech/{voice_id}  → audio/mpeg
// STT:  POST /v1/speech-to-text             → JSON { text, language, ... }
// Voices: GET /v1/voices                    → JSON { voices: [...] }

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// ─── Voice ──────────────────────────────────────────────────────────────────

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  description?: string;
  preview_url?: string;
}

// ─── TTS ────────────────────────────────────────────────────────────────────

export interface ElevenLabsTTSOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;        // 0.0–1.0
  similarityBoost?: number;  // 0.0–1.0
  style?: number;            // 0.0–1.0
  useSpeakerBoost?: boolean;
}

/**
 * Synthesize speech via ElevenLabs TTS. Returns MP3 bytes.
 * Throws on failure with the API's own error message.
 */
export async function elevenLabsTTS(
  text: string,
  apiKey: string,
  opts: ElevenLabsTTSOptions = {},
): Promise<Buffer> {
  const voiceId = opts.voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)
  const modelId = opts.modelId || 'eleven_multilingual_v2';

  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
  };

  const voiceSettings: Record<string, unknown> = {};
  if (opts.stability !== undefined) voiceSettings.stability = opts.stability;
  if (opts.similarityBoost !== undefined) voiceSettings.similarity_boost = opts.similarityBoost;
  if (opts.style !== undefined) voiceSettings.style = opts.style;
  if (opts.useSpeakerBoost !== undefined) voiceSettings.use_speaker_boost = opts.useSpeakerBoost;
  if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings;

  const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS HTTP ${response.status}: ${errText.slice(0, 500)}`);
  }

  const arrayBuf = await response.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ─── STT ────────────────────────────────────────────────────────────────────

export interface ElevenLabsSTTResult {
  text: string;
  language_code?: string;
  language_probability?: number;
  duration?: number;
}

/**
 * Transcribe an audio file via ElevenLabs STT.
 * Accepts any format ffmpeg can read; converts to 16 kHz mono WAV first.
 */
export async function elevenLabsSTT(
  audioPath: string,
  apiKey: string,
  modelId: string = 'scribe_v1',
): Promise<ElevenLabsSTTResult> {
  // ElevenLabs STT accepts the file directly, but we normalize first
  // for consistency with the rest of the pipeline.
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'el-stt-'));
  let wavPath = path.join(tmpDir, 'input.wav');

  try {
    // Normalize to 16 kHz mono WAV
    try {
      execSync(
        `ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`,
        { stdio: 'pipe', timeout: 15000 },
      );
    } catch {
      // If ffmpeg fails, try the original file directly
      wavPath = audioPath;
    }

    const fileBuffer = fs.readFileSync(wavPath);
    const blob = new Blob([fileBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, path.basename(wavPath));
    formData.append('model_id', modelId);

    const response = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs STT HTTP ${response.status}: ${errText.slice(0, 500)}`);
    }

    return await response.json() as Promise<ElevenLabsSTTResult>;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Voice listing ──────────────────────────────────────────────────────────

/**
 * List available ElevenLabs voices.
 */
export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const response = await fetch(`${ELEVENLABS_BASE}/voices`, {
    method: 'GET',
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs voices HTTP ${response.status}: ${errText.slice(0, 500)}`);
  }

  const data = await response.json() as { voices?: ElevenLabsVoice[] };
  return data.voices ?? [];
}

// ─── Audio playback (shared with dictate.ts) ────────────────────────────────

/**
 * Play an audio buffer through the sound server.
 * Prefers paplay (PipeWire) → pw-play → ffplay → aplay.
 */
export function playAudioBuffer(buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const players = ['paplay', 'pw-play', 'ffplay', 'aplay'];
    let player: string | null = null;
    for (const p of players) {
      try { execSync('which ' + p, { stdio: 'pipe' }); player = p; break; } catch {}
    }
    if (!player) { reject(new Error('No audio player found (install paplay, pw-play, ffplay, or aplay)')); return; }

    const args: string[] = [];
    if (player === 'paplay') args.push('--raw', '--rate=44100', '--channels=1', '--format=s16le');
    else if (player === 'pw-play') args.push('--raw', '--rate=44100', '--channels=1', '--format=s16le');
    else if (player === 'ffplay') args.push('-f', 's16le', '-ar', '44100', '-ac', '1', '-nodisp', '-autoexit', '-');

    const proc = spawn(player, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(`${player} exited with code ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n').slice(-1)[0] : ''}`));
    });
    proc.stdin.write(buf);
    proc.stdin.end();
  });
}

// spawn is used by playAudioBuffer above

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shadow Shield — Apartment security: webcam + microphone surveillance
// Captures snapshots and audio levels every 10 minutes, alerts on changes
// ─────────────────────────────────────────────────────────────────────────────

export interface ShadowShieldInput {
  action: 'start' | 'stop' | 'status' | 'snapshot' | 'scan';
  interval_minutes?: number;   // default: 10
  video_device?: string;       // default: /dev/video0
  audio_device?: string;       // default: default
  sensitivity?: number;        // 1-10, default: 5 (lower = more sensitive)
  telegram_chat_id?: string;   // override default chat id
}

export const SHADOW_SHIELD_DEFINITION: ToolDefinition = {
  name: 'shadow_shield',
  description:
    'Apartment security surveillance module. Tracks webcam and microphone for environment changes. ' +
    'Captures webcam snapshots and audio levels every N minutes (default 10). ' +
    'Sends alerts with photos to Telegram when changes are detected. ' +
    'Actions: start (begin surveillance loop), stop (halt surveillance), status (show current state), ' +
    'snapshot (take single snapshot and send), scan (one-time check without starting loop).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: start, stop, status, snapshot, scan',
      },
      interval_minutes: {
        type: 'number',
        description: 'Minutes between surveillance sweeps (default: 10)',
      },
      video_device: {
        type: 'string',
        description: 'Video device path (default: /dev/video0)',
      },
      audio_device: {
        type: 'string',
        description: 'Audio device name (default: default)',
      },
      sensitivity: {
        type: 'number',
        description: 'Change sensitivity 1-10 (default: 5, lower = more sensitive)',
      },
      telegram_chat_id: {
        type: 'string',
        description: 'Override Telegram chat ID for alerts',
      },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotMeta {
  timestamp: string;
  filePath: string;
  fileSize: number;
  hash: string;
}

interface AudioMeta {
  timestamp: string;
  peakLevel: number;    // 0-100
  rmsLevel: number;     // 0-100
  duration: number;     // seconds
}

interface SurveillanceState {
  running: boolean;
  startedAt: string | null;
  intervalMinutes: number;
  videoDevice: string;
  audioDevice: string;
  sensitivity: number;
  telegramChatId: string | null;
  lastSnapshot: SnapshotMeta | null;
  lastAudio: AudioMeta | null;
  alertsSent: number;
  scansCompleted: number;
  timer: ReturnType<typeof setInterval> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let state: SurveillanceState = {
  running: false,
  startedAt: null,
  intervalMinutes: 10,
  videoDevice: '/dev/video0',
  audioDevice: 'default',
  sensitivity: 5,
  telegramChatId: null,
  lastSnapshot: null,
  lastAudio: null,
  alertsSent: 0,
  scansCompleted: 0,
  timer: null,
};

const TEMP_DIR = path.join(os.tmpdir(), 'shadow-shield');
const SNAPSHOT_PATH = path.join(TEMP_DIR, 'snapshot.jpg');
const PREV_SNAPSHOT_PATH = path.join(TEMP_DIR, 'snapshot-prev.jpg');
const AUDIO_PATH = path.join(TEMP_DIR, 'audio-sample.wav');

// ─────────────────────────────────────────────────────────────────────────────
// Telegram config loader
// ─────────────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  bot_token: string;
  default_chat_id?: string;
}

function loadTelegramConfig(): TelegramConfig | null {
  const p = path.join(os.homedir(), '.aura', 'telegram.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webcam capture
// ─────────────────────────────────────────────────────────────────────────────

function captureSnapshot(device: string): SnapshotMeta | null {
  try {
    // Ensure temp dir exists
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    // Rotate previous snapshot
    if (fs.existsSync(SNAPSHOT_PATH)) {
      fs.copyFileSync(SNAPSHOT_PATH, PREV_SNAPSHOT_PATH);
    }

    // Capture single frame from webcam via ffmpeg
    execSync(
      `ffmpeg -f v4l2 -video_size 1280x720 -i ${device} -frames:v 1 -y "${SNAPSHOT_PATH}" 2>/dev/null`,
      { timeout: 15_000, stdio: 'pipe' },
    );

    if (!fs.existsSync(SNAPSHOT_PATH)) return null;

    const stat = fs.statSync(SNAPSHOT_PATH);
    const buffer = fs.readFileSync(SNAPSHOT_PATH);
    const hash = simpleHash(buffer);

    return {
      timestamp: new Date().toISOString(),
      filePath: SNAPSHOT_PATH,
      fileSize: stat.size,
      hash,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio capture + level analysis
// ─────────────────────────────────────────────────────────────────────────────

function captureAudioLevels(device: string, durationSec: number = 5): AudioMeta | null {
  try {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    // Record short audio sample
    execSync(
      `ffmpeg -f pulse -i ${device} -t ${durationSec} -y "${AUDIO_PATH}" 2>/dev/null`,
      { timeout: (durationSec + 5) * 1000, stdio: 'pipe' },
    );

    if (!fs.existsSync(AUDIO_PATH)) return null;

    // Analyze audio levels using ffmpeg volumedetect filter
    let peakLevel = 0;
    let rmsLevel = 0;

    try {
      const output = execSync(
        `ffmpeg -i "${AUDIO_PATH}" -af volumedetect -f null - 2>&1`,
        { encoding: 'utf8', timeout: 10_000 },
      );

      const peakMatch = output.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/);
      const rmsMatch = output.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/);

      if (peakMatch) {
        // Convert dB to 0-100 scale (0dB = 100, -60dB = ~0)
        const db = parseFloat(peakMatch[1]);
        peakLevel = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
      }
      if (rmsMatch) {
        const db = parseFloat(rmsMatch[1]);
        rmsLevel = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
      }
    } catch {
      // Fallback: estimate from file size (larger = louder)
      const stat = fs.statSync(AUDIO_PATH);
      peakLevel = Math.min(100, Math.round((stat.size / (durationSec * 44100 * 2)) * 100));
      rmsLevel = Math.round(peakLevel * 0.7);
    }

    return {
      timestamp: new Date().toISOString(),
      peakLevel,
      rmsLevel,
      duration: durationSec,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change detection
// ─────────────────────────────────────────────────────────────────────────────

function simpleHash(buffer: Buffer): string {
  // FNV-1a inspired fast hash — not crypto, just change detection
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 64) {
    hash ^= buffer[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

interface ChangeResult {
  visualChange: boolean;
  audioChange: boolean;
  details: string[];
}

function detectChanges(
  current: SnapshotMeta,
  previous: SnapshotMeta | null,
  currentAudio: AudioMeta | null,
  previousAudio: AudioMeta | null,
  sensitivity: number,
): ChangeResult {
  const details: string[] = [];
  let visualChange = false;
  let audioChange = false;

  // Visual change: compare hash (exact pixel change)
  if (previous) {
    if (current.hash !== previous.hash) {
      visualChange = true;
      const sizeDiff = Math.abs(current.fileSize - previous.fileSize);
      const pctDiff = ((sizeDiff / previous.fileSize) * 100).toFixed(1);
      details.push(`Visual change detected (${pctDiff}% file size diff)`);
    }

    // Also compare actual pixel data if hashes differ
    if (visualChange) {
      const pixelDiff = comparePixelData(current.filePath, previous.filePath);
      // Sensitivity threshold: sensitivity 1 = detect 0.5% change, 10 = detect 15% change
      const threshold = 0.5 + (sensitivity - 1) * 1.6;
      if (pixelDiff < threshold) {
        // Below threshold — noise, not a real change
        visualChange = false;
        details.pop();
      } else {
        details.push(`Pixel difference: ${pixelDiff.toFixed(1)}%`);
      }
    }
  } else {
    // First snapshot — always count as change
    visualChange = true;
    details.push('First snapshot captured');
  }

  // Audio change: compare peak/rms levels
  if (currentAudio && previousAudio) {
    const peakDiff = Math.abs(currentAudio.peakLevel - previousAudio.peakLevel);
    const rmsDiff = Math.abs(currentAudio.rmsLevel - previousAudio.rmsLevel);

    // Sensitivity: lower sensitivity number = more sensitive
    const audioThreshold = 5 + (sensitivity - 1) * 3; // 5 to 32

    if (peakDiff > audioThreshold || rmsDiff > audioThreshold) {
      audioChange = true;
      details.push(
        `Audio change: peak ${previousAudio.peakLevel}→${currentAudio.peakLevel}, ` +
        `rms ${previousAudio.rmsLevel}→${currentAudio.rmsLevel}`,
      );
    }
  } else if (currentAudio) {
    details.push(`Audio baseline: peak=${currentAudio.peakLevel}, rms=${currentAudio.rmsLevel}`);
  }

  return { visualChange, audioChange, details };
}

function comparePixelData(currentPath: string, previousPath: string): number {
  try {
    // Use ImageMagick compare if available
    const output = execSync(
      `compare -metric AE "${previousPath}" "${currentPath}" /dev/null 2>&1 || true`,
      { encoding: 'utf8', timeout: 10_000 },
    );
    const diffPixels = parseInt(output.trim(), 10);
    if (isNaN(diffPixels)) return 0;
    // 1280*720 = 921600 total pixels
    return (diffPixels / 921600) * 100;
  } catch {
    // Fallback: compare file sizes as rough proxy
    try {
      const a = fs.statSync(currentPath).size;
      const b = fs.statSync(previousPath).size;
      return (Math.abs(a - b) / Math.max(a, b)) * 100;
    } catch {
      return 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram alerting
// ─────────────────────────────────────────────────────────────────────────────

async function sendTelegramAlert(
  changes: ChangeResult,
  snapshot: SnapshotMeta,
  audio: AudioMeta | null,
): Promise<string> {
  const config = loadTelegramConfig();
  if (!config) {
    return 'Telegram not configured — alert skipped (create ~/.aura/telegram.json)';
  }

  const chatId = state.telegramChatId ?? config.default_chat_id;
  if (!chatId) {
    return 'No Telegram chat_id — alert skipped';
  }

  const timestamp = new Date().toLocaleString();
  const alertType = changes.visualChange && changes.audioChange
    ? '🔊📹 VISUAL + AUDIO CHANGE'
    : changes.visualChange
      ? '📹 VISUAL CHANGE'
      : '🔊 AUDIO CHANGE';

  const caption = [
    `🛡️ <b>Shadow Shield Alert</b>`,
    `${alertType}`,
    `⏰ ${timestamp}`,
    '',
    ...changes.details.map(d => `• ${d}`),
    '',
    audio ? `🎤 Audio: peak=${audio.peakLevel} rms=${audio.rmsLevel}` : '',
    `📷 Snapshot: ${snapshot.fileSize} bytes`,
  ].filter(Boolean).join('\n');

  try {
    // Send photo with caption
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    const photoBuffer = fs.readFileSync(snapshot.filePath);
    form.append('photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'snapshot.jpg');

    const response = await fetch(
      `https://api.telegram.org/bot${config.bot_token}/sendPhoto`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) },
    );

    const data = await response.json() as any;
    if (data.ok) {
      state.alertsSent++;
      return `Alert sent to ${chatId} (msg_id: ${data.result.message_id})`;
    }
    return `Telegram error: ${data.description ?? 'unknown'}`;
  } catch (e: any) {
    return `Telegram send error: ${e?.message ?? String(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Surveillance sweep
// ─────────────────────────────────────────────────────────────────────────────

async function performSweep(): Promise<string> {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push(`[${now}] Shadow Shield sweep #${state.scansCompleted + 1}`);

  // Capture webcam
  const snapshot = captureSnapshot(state.videoDevice);
  if (!snapshot) {
    lines.push('⚠️ Webcam capture failed — device unavailable?');
    return lines.join('\n');
  }
  lines.push(`📷 Snapshot: ${snapshot.fileSize} bytes, hash=${snapshot.hash}`);

  // Capture audio
  const audio = captureAudioLevels(state.audioDevice);
  if (audio) {
    lines.push(`🎤 Audio: peak=${audio.peakLevel}, rms=${audio.rmsLevel}`);
  } else {
    lines.push('⚠️ Audio capture failed — continuing without audio');
  }

  // Detect changes
  const changes = detectChanges(
    snapshot,
    state.lastSnapshot,
    audio,
    state.lastAudio,
    state.sensitivity,
  );

  if (changes.details.length > 0) {
    lines.push(...changes.details.map(d => `  → ${d}`));
  }

  // Alert if changes detected
  if (changes.visualChange || changes.audioChange) {
    lines.push('🚨 Change detected — sending Telegram alert...');
    const alertResult = await sendTelegramAlert(changes, snapshot, audio);
    lines.push(`  ${alertResult}`);
  } else {
    lines.push('✅ No significant changes detected');
  }

  // Update state
  state.lastSnapshot = snapshot;
  state.lastAudio = audio;
  state.scansCompleted++;

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function doStart(input: ShadowShieldInput): Promise<string> {
  if (state.running) {
    return `Shadow Shield already running (since ${state.startedAt}, ${state.scansCompleted} scans, ${state.alertsSent} alerts sent)`;
  }

  // Apply config
  state.intervalMinutes = input.interval_minutes ?? 10;
  state.videoDevice = input.video_device ?? '/dev/video0';
  state.audioDevice = input.audio_device ?? 'default';
  state.sensitivity = input.sensitivity ?? 5;
  state.telegramChatId = input.telegram_chat_id ?? null;

  // Validate ffmpeg availability
  try {
    execSync('which ffmpeg', { stdio: 'pipe' });
  } catch {
    return 'Error: ffmpeg not installed. Install with: sudo apt install ffmpeg';
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.alertsSent = 0;
  state.scansCompleted = 0;

  // Run first sweep immediately
  const firstSweep = await performSweep();

  // Schedule recurring sweeps
  const intervalMs = state.intervalMinutes * 60 * 1000;
  state.timer = setInterval(async () => {
    if (!state.running) return;
    try {
      await performSweep();
    } catch (e) {
      // Don't crash the loop on errors
    }
  }, intervalMs);

  return [
    '🛡️ Shadow Shield ACTIVATED',
    '',
    `📹 Video device: ${state.videoDevice}`,
    `🎤 Audio device: ${state.audioDevice}`,
    `⏱️ Interval: every ${state.intervalMinutes} minutes`,
    `🎯 Sensitivity: ${state.sensitivity}/10`,
    '',
    '--- First sweep ---',
    firstSweep,
  ].join('\n');
}

function doStop(): string {
  if (!state.running) {
    return 'Shadow Shield is not running.';
  }

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  const summary = {
    startedAt: state.startedAt,
    stoppedAt: new Date().toISOString(),
    scansCompleted: state.scansCompleted,
    alertsSent: state.alertsSent,
  };

  state.running = false;
  state.startedAt = null;

  return [
    '🛡️ Shadow Shield DEACTIVATED',
    '',
    `Started: ${summary.startedAt}`,
    `Stopped: ${summary.stoppedAt}`,
    `Scans completed: ${summary.scansCompleted}`,
    `Alerts sent: ${summary.alertsSent}`,
  ].join('\n');
}

function doStatus(): string {
  const lines = [
    '🛡️ Shadow Shield Status',
    '─'.repeat(30),
    `State: ${state.running ? '🟢 ACTIVE' : '🔴 INACTIVE'}`,
  ];

  if (state.running) {
    lines.push(`Started: ${state.startedAt}`);
    lines.push(`Interval: every ${state.intervalMinutes} minutes`);
    lines.push(`Video: ${state.videoDevice}`);
    lines.push(`Audio: ${state.audioDevice}`);
    lines.push(`Sensitivity: ${state.sensitivity}/10`);
  }

  lines.push(`Scans completed: ${state.scansCompleted}`);
  lines.push(`Alerts sent: ${state.alertsSent}`);

  if (state.lastSnapshot) {
    lines.push('');
    lines.push('Last snapshot:');
    lines.push(`  Time: ${state.lastSnapshot.timestamp}`);
    lines.push(`  Size: ${state.lastSnapshot.fileSize} bytes`);
    lines.push(`  Hash: ${state.lastSnapshot.hash}`);
  }

  if (state.lastAudio) {
    lines.push('');
    lines.push('Last audio:');
    lines.push(`  Time: ${state.lastAudio.timestamp}`);
    lines.push(`  Peak: ${state.lastAudio.peakLevel}`);
    lines.push(`  RMS:  ${state.lastAudio.rmsLevel}`);
  }

  // Check Telegram config
  const tgConfig = loadTelegramConfig();
  lines.push('');
  lines.push(`Telegram: ${tgConfig ? '✅ configured' : '❌ not configured'}`);

  return lines.join('\n');
}

async function doSnapshot(): Promise<string> {
  const videoDevice = state.videoDevice || '/dev/video0';
  const snapshot = captureSnapshot(videoDevice);

  if (!snapshot) {
    return `Error: Failed to capture snapshot from ${videoDevice}`;
  }

  // Send to Telegram
  const config = loadTelegramConfig();
  if (!config) {
    return `Snapshot captured (${snapshot.fileSize} bytes) but Telegram not configured. Photo saved at: ${snapshot.filePath}`;
  }

  const chatId = state.telegramChatId ?? config.default_chat_id;
  if (!chatId) {
    return `Snapshot captured (${snapshot.fileSize} bytes) but no Telegram chat_id. Photo at: ${snapshot.filePath}`;
  }

  const caption = `📷 Shadow Shield Snapshot\n⏰ ${new Date().toLocaleString()}\n📦 ${snapshot.fileSize} bytes`;

  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);

    const photoBuffer = fs.readFileSync(snapshot.filePath);
    form.append('photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'snapshot.jpg');

    const response = await fetch(
      `https://api.telegram.org/bot${config.bot_token}/sendPhoto`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) },
    );

    const data = await response.json() as any;
    if (data.ok) {
      return `Snapshot sent to ${chatId} (msg_id: ${data.result.message_id}) — ${snapshot.fileSize} bytes`;
    }
    return `Snapshot captured but Telegram send failed: ${data.description}`;
  } catch (e: any) {
    return `Snapshot captured but Telegram error: ${e?.message ?? String(e)}`;
  }
}

async function doScan(): Promise<string> {
  if (state.running) {
    return 'Shadow Shield is already running. Use status to check, or stop + scan for a one-time check.';
  }

  // Save and restore sensitivity
  const savedSensitivity = state.sensitivity;
  state.sensitivity = 5;
  state.lastSnapshot = null; // Force full comparison
  state.lastAudio = null;

  const result = await performSweep();

  // Restore
  state.lastSnapshot = null;
  state.lastAudio = null;
  state.scansCompleted = 0;
  state.sensitivity = savedSensitivity;

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function shadowShield(input: ShadowShieldInput): Promise<string> {
  try {
    switch (input.action) {
      case 'start':    return await doStart(input);
      case 'stop':     return doStop();
      case 'status':   return doStatus();
      case 'snapshot': return await doSnapshot();
      case 'scan':     return await doScan();
      default:         return `Error: Unknown shadow_shield action: ${input.action}`;
    }
  } catch (e: any) {
    return `Shadow Shield error: ${e?.message ?? String(e)}`;
  }
}

#!/usr/bin/env node
// Aura Telegram Bot — listens for messages, processes them, responds
// Uses https module instead of fetch (Node fetch broken on this system)
// Usage: npx tsx src/tools/telegram-bot.ts

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { exec, execSync, execFileSync } from 'child_process';
import { createProvider, registerCustomProviders } from '../providers/factory.js';
import { loadProjectConfig } from '../config/project-config.js';
import { transcribeFile, synthesizeSpeech } from './dictate.js';
import {
  normalizeAudioMode, shouldSendAudio, stripForSpeech, DEFAULT_AUDIO_MIN_CHARS,
  type AudioReplyMode,
} from './telegram-audio-policy.js';
import { textToSpeech, sendVoiceMessage } from './telegram-voice.js';
import { getApiKey } from '../util/env.js';
import { loadUnifiedMemory } from '../agent/unified-memory.js';
import type { HistoryMessage, LLMProvider } from '../providers/types.js';
import type { ChatSession } from '../agent/session-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  bot_token: string;
  default_chat_id?: string;
  model?: string;          // LLM model for chat (default: gemini-2.0-flash)
  system_prompt?: string;  // system prompt override
  /** Telegram user IDs allowed to use the bot. If set, everyone else is
   *  refused (the bot can run shell commands, so this gate is mandatory). */
  allowed_user_ids?: string | string[];
  /** Voice-note replies: 'off' | 'voice-only' | 'auto' (default) | 'always'.
   *  'auto' = text always, plus a voice note for voice-in messages and for
   *  substantial conversational replies (≥ audio_min_chars). */
  audio_replies?: string;
  /** Reply length (chars) at which 'auto' mode adds a voice note. Default 500. */
  audio_min_chars?: number;
}

function loadConfig(): TelegramConfig {
  const configPath = path.join(os.homedir(), '.aura', 'telegram.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ Config not found. Create ~/.aura/telegram.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTPS helper (no fetch dependency)
// ─────────────────────────────────────────────────────────────────────────────

const config = loadConfig();
const TOKEN = config.bot_token;
const OFFSET_FILE = path.join(os.homedir(), '.aura', 'telegram.offset');

// ── Authorization: only allowed users may talk to the bot ────────────────────
// The bot can run shell commands, send files, and take webcam photos, so an
// open door means anyone who finds it controls the PC. If allowed_user_ids is
// set, everyone else is silently refused.
const ALLOWED_USER_IDS: string[] = (() => {
  const raw = config.allowed_user_ids;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
})();

// ── Audio replies: when to attach a voice note alongside the text reply ──────
const AUDIO_MODE: AudioReplyMode = normalizeAudioMode(config.audio_replies);
const AUDIO_MIN_CHARS: number =
  Number.isFinite(config.audio_min_chars) && (config.audio_min_chars as number) > 0
    ? (config.audio_min_chars as number)
    : DEFAULT_AUDIO_MIN_CHARS;

function isAuthorized(userId: string | number | undefined): boolean {
  if (ALLOWED_USER_IDS.length === 0) return true; // no allowlist configured → open (logged as a warning at startup)
  return userId != null && ALLOWED_USER_IDS.includes(String(userId));
}

// Register custom providers from project's .aura.json (needed for deepseek/ etc.)
const projectCfg = loadProjectConfig(process.cwd());
if (projectCfg.providers && projectCfg.providers.length > 0) {
  registerCustomProviders(projectCfg.providers);
}

// Disable connection pooling — each long-poll needs a fresh TCP connection
// to avoid "409 Conflict: terminated by other getUpdates request"
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 1 });

function loadOffset(): number {
  try {
    return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset: number): void {
  fs.writeFileSync(OFFSET_FILE, String(offset), 'utf8');
}

function apiPost(method: string, body?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      family: 4, // force IPv4 — IPv6 may not be routable
      agent: httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (!parsed.ok) {
            reject(new Error(`Telegram: ${parsed.description} (${parsed.error_code})`));
          } else {
            resolve(parsed.result);
          }
        } catch (e: any) {
          reject(new Error(`Parse error: ${responseData.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e: any) => reject(new Error(`HTTPS error: ${e?.message || e?.code || JSON.stringify(e)}`)));
    req.setTimeout(35000, () => {
      req.destroy();
      reject(new Error('Request timeout (35s)'));
    });

    if (data) req.write(data);
    req.end();
  });
}

function apiGet(method: string, params?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/${method}${qs}`,
      method: 'GET',
      family: 4, // force IPv4 — IPv6 may not be routable
      agent: httpsAgent,
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (!parsed.ok) {
            reject(new Error(`Telegram: ${parsed.description || '(no description)'} (${parsed.error_code})`));
          } else {
            resolve(parsed.result);
          }
        } catch (e: any) {
          reject(new Error(`Parse error: ${responseData.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e: any) => reject(new Error(`HTTPS error: ${e?.message || e?.code || JSON.stringify(e)}`)));
    req.setTimeout(35000, () => {
      req.destroy();
      reject(new Error('Request timeout (35s)'));
    });

    req.end();
  });
}

async function sendMessage(chatId: string | number, text: string): Promise<void> {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await apiPost('sendMessage', { chat_id: chatId, text: chunk });
  }
}

// Send a local file as a document to Telegram
async function sendLocalFile(chatId: string | number, filePath: string, caption?: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    await sendMessage(chatId, `❌ File not found: ${filePath}`);
    return;
  }

  // For small files (<10MB), use sendDocument with base64 or multipart
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  if (fileSize > 50 * 1024 * 1024) {
    await sendMessage(chatId, `❌ File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB (max 50MB)`);
    return;
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '----TelegramFormBoundary' + Date.now().toString(16);

    const formData = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="chat_id"`,
      '',
      String(chatId),
    ];

    if (caption) {
      formData.push(
        `--${boundary}`,
        `Content-Disposition: form-data; name="caption"`,
        '',
        caption,
      );
    }

    const fileName = path.basename(filePath);
    formData.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="document"; filename="${fileName}"`,
      `Content-Type: application/octet-stream`,
      '',
    );

    const formDataHeader = formData.join('\r\n') + '\r\n\r\n';
    const formDataFooter = `\r\n--${boundary}--\r\n`;

    const fullData = Buffer.concat([
      Buffer.from(formDataHeader, 'utf8'),
      fileBuffer,
      Buffer.from(formDataFooter, 'utf8'),
    ]);

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${TOKEN}/sendDocument`,
        method: 'POST',
        family: 4,
        agent: httpsAgent,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': fullData.length,
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (!parsed.ok) {
              reject(new Error(`Telegram: ${parsed.description} (${parsed.error_code})`));
            } else {
              resolve(parsed.result);
            }
          } catch (e: any) {
            reject(new Error(`Parse error: ${responseData.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (e: any) => reject(new Error(`HTTPS error: ${e?.message || e?.code || JSON.stringify(e)}`)));
      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error('File upload timeout (60s)'));
      });

      req.write(fullData);
      req.end();
    });
  } catch (e: any) {
    await sendMessage(chatId, `❌ Error reading file: ${e.message}`);
  }
}

// ─── Voice: download an incoming voice note, and send a voice reply ──────────

/** Download a Telegram file (by file_id) to a local temp path. Returns the path. */
async function downloadTelegramFile(fileId: string): Promise<string> {
  const info = await apiPost('getFile', { file_id: fileId });
  const remotePath: string = info.file_path;
  const tmp = path.join(os.tmpdir(), `tg-voice-${Date.now()}-${path.basename(remotePath)}`);
  await new Promise<void>((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org', port: 443,
      path: `/file/bot${TOKEN}/${remotePath}`, method: 'GET', family: 4, agent: httpsAgent,
    };
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`file download HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('file download timeout')); });
    req.end();
  });
  return tmp;
}

/** Send a WAV buffer as a Telegram voice message (converts to OGG/Opus). */
async function sendVoice(chatId: string | number, wavBuffer: Buffer, caption?: string): Promise<void> {
  // Telegram voice notes must be OGG/Opus, mono. Encode exactly how Telegram
  // expects (48 kHz mono Opus, voip application) — otherwise the note shows a
  // 0:00 empty duration. Content-Type of the part MUST be audio/ogg, not
  // octet-stream, or Telegram won't read it as a playable voice message.
  const tmpWav = path.join(os.tmpdir(), `tg-tts-${Date.now()}.wav`);
  const tmpOgg = tmpWav.replace(/\.wav$/, '.ogg');
  fs.writeFileSync(tmpWav, wavBuffer);
  try {
    execSync(
      `ffmpeg -y -i "${tmpWav}" -ac 1 -ar 48000 -c:a libopus -b:a 24k -application voip "${tmpOgg}" 2>/dev/null`,
      { stdio: 'pipe', timeout: 20000 },
    );
  } catch {
    // No opus encoder — fall back to sending the WAV as an audio file.
    try { fs.unlinkSync(tmpOgg); } catch {}
  }
  const haveOgg = fs.existsSync(tmpOgg) && fs.statSync(tmpOgg).size > 0;
  const sendPath = haveOgg ? tmpOgg : tmpWav;
  const fieldName = haveOgg ? 'voice' : 'audio';
  const method = haveOgg ? 'sendVoice' : 'sendAudio';
  const partMime = haveOgg ? 'audio/ogg' : 'audio/wav';
  // Upload via curl, NOT a hand-built Node multipart body: an identical OGG
  // sent through Node's raw https multipart arrives at Telegram with
  // duration:0 (empty voice note), while the exact same bytes via curl come
  // through as a proper duration:N voice message. curl's multipart framing is
  // what Telegram's Opus parser expects; ours subtly isn't. So shell out.
  try {
    const args = [
      '-s', '--max-time', '60',
      '-F', `chat_id=${chatId}`,
      '-F', `${fieldName}=@${sendPath};type=${partMime}`,
    ];
    if (caption) args.push('-F', `caption=${caption}`);
    args.push(`https://api.telegram.org/bot${TOKEN}/${method}`);
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 65000 });
    const parsed = JSON.parse(out);
    if (!parsed.ok) throw new Error(`Telegram: ${parsed.description} (${parsed.error_code})`);
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
    try { fs.unlinkSync(tmpOgg); } catch {}
  }
}

// ─── Photo + camera ─────────────────────────────────────────────────────────

/** Send an image file as a Telegram photo (via curl — same reliable path as voice). */
async function sendPhoto(chatId: string | number, imagePath: string, caption?: string): Promise<void> {
  if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
  const args = ['-s', '--max-time', '60', '-F', `chat_id=${chatId}`, '-F', `photo=@${imagePath}`];
  if (caption) args.push('-F', `caption=${caption}`);
  args.push(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
  const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 65000 });
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`Telegram: ${parsed.description} (${parsed.error_code})`);
}

/**
 * Capture a single frame from a webcam and return the JPEG path (caller sends
 * + cleans up). Uses ffmpeg v4l2 on Dušan's integrated camera (/dev/video0).
 */
function captureWebcam(device = '/dev/video0'): string {
  const out = path.join(os.tmpdir(), `cam-${Date.now()}.jpg`);
  // -update 1 lets a single-image output overwrite cleanly; small warmup helps
  // the sensor auto-expose before the grab.
  execSync(
    `ffmpeg -y -f v4l2 -i "${device}" -frames:v 1 -update 1 "${out}" 2>/dev/null`,
    { stdio: 'pipe', timeout: 20000 },
  );
  if (!fs.existsSync(out) || fs.statSync(out).size < 1000) {
    throw new Error(`camera capture failed (${device})`);
  }
  return out;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM chat — answers free-form questions
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CHAT_MODEL = config.model || 'deepseek/deepseek-v4-flash';
const CHAT_HISTORY_MAX = 50; // keep last N messages per chat for context
const SESSION_DIR = path.join(os.homedir(), '.aura', 'sessions', 'telegram');

let _chatProvider: LLMProvider | null = null;
let _identityBlock = ''; // loaded from memory on startup

// ─────────────────────────────────────────────────────────────────────────────
// Session persistence — share conversations with PC CLI
// ─────────────────────────────────────────────────────────────────────────────

function getSessionFile(chatId: string): string {
  // Use chat ID as session ID — same as CLI uses for consistency
  return path.join(SESSION_DIR, `${chatId}.json`);
}

async function loadSession(chatId: string): Promise<ChatSession | null> {
  const filePath = getSessionFile(chatId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as ChatSession;
  } catch (e) {
    console.error(`[${ts()}] ⚠️ Failed to load session ${chatId}:`, e);
    return null;
  }
}

async function saveSession(chatId: string, history: HistoryMessage[]): Promise<void> {
  const session = await loadSession(chatId);
  const now = new Date().toISOString();

  const newSession: ChatSession = session ? {
    ...session,
    history,
    updatedAt: now,
  } : {
    id: chatId,
    title: `Telegram ${chatId}`,
    createdAt: now,
    updatedAt: now,
    version: 1,
    history,
  };

  const filePath = getSessionFile(chatId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(newSession, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
}

function loadIdentityFromMemory(): string {
  // Unified memory: full global identity/facts (shared with the CLI) plus the
  // global episodic-lessons digest. No projectRoot → the bot isn't tied to one
  // project, so it gets the cross-project lessons summary.
  return loadUnifiedMemory({ maxChars: 3500 });
}

// Build system prompt once on first use — includes user identity from memory
function buildSystemPrompt(): string {
  if (!_identityBlock) {
    _identityBlock = loadIdentityFromMemory();
  }
  const base = config.system_prompt || [
    'You are Aura — a precise, self-aware AI assistant. Reply concisely.',
    'ALWAYS reply in the SAME language the user just wrote in: if they write in',
    'English, answer in English; if in Serbian, answer in Serbian. Match their',
    'language every message — never default to Serbian when they wrote English.',
    'The user is Dušan — your creator. Use his name when natural. You know him',
    'well; he built you. Be warm but professional.',
    'If asked for help, say "/help for commands".',
    'Never make things up — be honest when you don\'t know.',
  ].join(' ');
  return base + _identityBlock;
}

// Per-chat conversation history — loaded from disk on startup, saved after each message
const chatHistory = new Map<string, HistoryMessage[]>();
// Track which sessions were modified since last save
const dirtySessions = new Set<string>();

async function initializeChatHistory(): Promise<void> {
  const dir = SESSION_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[${ts()}]   Created telegram session directory`);
    return;
  }

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    console.log(`[${ts()}]   Loading ${files.length} chat session(s) from disk…`);

    for (const file of files) {
      const chatId = file.replace('.json', '');
      const session = await loadSession(chatId);
      if (session && session.history.length > 0) {
        chatHistory.set(chatId, session.history);
        console.log(`[${ts()}]   ✓ Loaded ${chatId}: ${session.history.length} messages`);
      }
    }

    if (files.length > 0) {
      console.log(`[${ts()}]   Chat history restored: ${chatHistory.size} session(s)`);
    }
  } catch (e: any) {
    console.error(`[${ts()}]   ⚠️ Failed to load chat history: ${e.message}`);
  }
}

function getChatHistory(chatId: string): HistoryMessage[] {
  if (!chatHistory.has(chatId)) {
    // Try loading from disk if not in memory
    loadSession(chatId).then(session => {
      if (session) {
        chatHistory.set(chatId, session.history);
      } else {
        chatHistory.set(chatId, []);
      }
    }).catch(() => {
      chatHistory.set(chatId, []);
    });
    return chatHistory.get(chatId) || [];
  }
  return chatHistory.get(chatId)!;
}

async function pushToHistory(chatId: string, msg: HistoryMessage): Promise<void> {
  const h = getChatHistory(chatId);
  h.push(msg);

  // Trim to keep last N messages
  while (h.length > CHAT_HISTORY_MAX) h.shift();

  // Mark as dirty and save to disk
  dirtySessions.add(chatId);
  await saveSession(chatId, h);
  dirtySessions.delete(chatId);
}

function getChatProvider(): LLMProvider {
  if (!_chatProvider) {
    _chatProvider = createProvider({ model: DEFAULT_CHAT_MODEL, temperature: 0.7, maxTokens: 4096 });
    console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]   Chat model: ${DEFAULT_CHAT_MODEL} (${_chatProvider.name})`);
  }
  return _chatProvider;
}

/** Block only truly catastrophic commands; everything else is allowed. Shared
 *  by /run and the agentic chat loop so both enforce the same floor. */
function isCatastrophic(cmd: string): boolean {
  const banned = [
    'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'mkfs', 'dd if=/dev/zero', 'dd if=/dev/random',
    ':(){ :|:& };:', 'fork bomb', 'shutdown', 'poweroff', 'init 0', 'halt', 'reboot',
    '> /dev/sda', 'chmod -R 000 /', 'chown -R',
  ];
  const c = cmd.toLowerCase();
  return banned.some(d => c.includes(d.toLowerCase()));
}

/**
 * A command is "read-only" (safe to run without approval) only if EVERY
 * whitespace/pipe/;-separated segment starts with a known inspection command
 * AND it contains no output redirection. Anything else (writes, installs,
 * deletes, unknown binaries) requires explicit approval. Deny-by-default: if
 * we're not sure it's read-only, we treat it as needing approval.
 */
const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'pwd', 'whoami', 'date', 'df', 'du', 'ps', 'top', 'free', 'uname',
  'which', 'find', 'grep', 'rg', 'head', 'tail', 'wc', 'echo', 'stat', 'file',
  'git', 'uptime', 'hostname', 'id', 'env', 'printenv', 'lsblk', 'lscpu', 'sensors',
  'nvidia-smi', 'systemctl', 'journalctl', 'sort', 'uniq', 'cut', 'awk', 'sed',
]);
function isReadOnlyCommand(cmd: string): boolean {
  if (/[>]|>>|\btee\b|\bdd\b/.test(cmd)) return false;       // any redirection → mutating
  // git/systemctl subcommands that mutate:
  if (/\bgit\s+(push|commit|reset|checkout|clean|rm|merge|rebase|stash\s+drop)\b/.test(cmd)) return false;
  if (/\bsystemctl\s+(start|stop|restart|enable|disable|mask)\b/.test(cmd)) return false;
  // Split on shell separators; every segment's first token must be read-only.
  const segments = cmd.split(/\||;|&&|\|\|/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const first = seg.split(/\s+/)[0].replace(/^sudo$/, '');
    if (first === 'sudo') return false;                       // sudo always needs approval
    if (!READ_ONLY_CMDS.has(first)) return false;
  }
  return true;
}

const AGENT_MAX_STEPS = 4;

// ── Approval flow ─────────────────────────────────────────────────────────────
// Mutating actions from the agent (or /run) don't execute immediately — they
// send an inline ✅/❌ to Dušan and wait. The callback handler in the poll loop
// resolves the matching promise. Keyed by a short callback id.
interface PendingApproval {
  resolve: (approved: boolean) => void;
  command: string;
  chatId: string;
  createdAt: number;
}
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

// ── Running-task registry (for /stop and /status) ────────────────────────────
// Message handlers are detached tasks, so several agentic runs can be in
// flight at once — even in the same chat. /stop aborts everything registered
// for that chat; the loop in chatWithLLM checks the signal between steps and
// races it against in-flight LLM calls so the stop lands promptly.
interface RunningTask {
  abort: AbortController;
  task: string;
  startedAt: number;
}
const runningTasks = new Map<string, Set<RunningTask>>();

function registerTask(chatId: string, entry: RunningTask): void {
  let set = runningTasks.get(chatId);
  if (!set) { set = new Set(); runningTasks.set(chatId, set); }
  set.add(entry);
}

function unregisterTask(chatId: string, entry: RunningTask): void {
  const set = runningTasks.get(chatId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) runningTasks.delete(chatId);
}

const ABORTED = Symbol('aborted');

/** Race a promise against an abort signal. On abort the caller moves on
 *  immediately; the losing in-flight call finishes in the background and its
 *  result is discarded (Promise.race keeps its rejection observed). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return Promise.race([
    p,
    new Promise<typeof ABORTED>((resolve) =>
      signal.addEventListener('abort', () => resolve(ABORTED), { once: true })),
  ]);
}

/** Resolve every pending approval for a chat. Returns how many were flushed. */
function flushApprovals(chatId: string, approved: boolean): number {
  let n = 0;
  for (const [id, p] of pendingApprovals) {
    if (p.chatId === chatId) {
      pendingApprovals.delete(id);
      p.resolve(approved);
      n++;
    }
  }
  return n;
}

/** Ask Dušan to approve a command; resolves true/false (false on timeout). */
async function requestApproval(chatId: string | number, label: string, command: string): Promise<boolean> {
  const id = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `ok:${id}` },
      { text: '❌ Deny', callback_data: `no:${id}` },
    ]],
  };
  await apiPost('sendMessage', {
    chat_id: chatId,
    text: `⚠️ Approve ${label}?\n\n\`${command.slice(0, 300)}\``,
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(id, { resolve, command, chatId: String(chatId), createdAt: Date.now() });
    setTimeout(() => {
      const p = pendingApprovals.get(id);
      if (p) { pendingApprovals.delete(id); p.resolve(false); }
    }, APPROVAL_TIMEOUT_MS);
  });
}

async function chatWithLLM(chatId: string, userMessage: string, userName: string): Promise<string> {
  const provider = getChatProvider();
  // Agentic system prompt: the model may run real shell commands on Dušan's PC
  // by emitting a line `RUN: <command>`. The bot executes it and feeds the
  // output back so the model can answer from real data (processes, files, etc).
  const systemPrompt = buildSystemPrompt() + [
    '',
    '## You CAN act on this computer (actions)',
    'You run on Dušan\'s Linux PC and have real abilities. To act, emit ONE line',
    'that is JUST the action (nothing else in that reply); the system performs it,',
    'sends you the result, and you then give your natural answer:',
    '  • `RUN: <shell command>` — inspect the PC (ps, free -h, df -h, ls, cat,',
    '    grep, git status…). Prefer read-only commands.',
    '  • `SEND: <file path>` — send a file to Dušan on Telegram (images go as',
    '    photos, everything else as a document). Use this whenever he asks you to',
    '    send / share / give him a file. You DO have file-sending ability.',
    '  • `CAM: [device]` — capture a webcam snapshot (default /dev/video0, the',
    '    integrated camera) and send it. Use for surveillance / "show me the room"',
    '    / "take a photo" requests.',
    'NEVER claim you cannot send files or take photos — you can, via SEND and CAM.',
    'Only use an action when needed; for normal conversation just reply directly.',
  ].join('\n');

  const recent = getChatHistory(chatId).slice(-(CHAT_HISTORY_MAX - 1));
  const history: HistoryMessage[] = [...recent, { role: 'user', content: userMessage }];
  await pushToHistory(String(chatId), { role: 'user', content: userMessage });

  const ts0 = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  // Register this run so /stop can abort it (per-chat; several runs may be
  // in flight since message handlers are detached).
  const runEntry: RunningTask = {
    abort: new AbortController(),
    task: userMessage.slice(0, 120),
    startedAt: Date.now(),
  };
  registerTask(chatId, runEntry);
  const signal = runEntry.abort.signal;
  try {
    let finalReply = '';
    for (let step = 0; step < AGENT_MAX_STEPS; step++) {
      const response = await raceAbort(provider.complete(systemPrompt, history, []), signal);
      if (response === ABORTED) {
        finalReply = '⏹ Stopped.';
        break;
      }
      const text = (response.text || '').trim();

      // Which action does the model want? RUN (shell), SEND (a file), CAM (webcam).
      // Models often wrap the directive in markdown — a leading backtick, bullet,
      // or blockquote — so tolerate those and strip a trailing backtick from the
      // argument. Without this the action leaks out as visible text.
      const action = text.match(/(?:^|\n)[ \t`>*_-]*(RUN|SEND|CAM):[ \t]*`?([^\n`]+)/);
      if (!action) {
        // No action → this is the answer. Strip any stray directive fragments
        // so raw "SEND:/RUN:" text never shows to the user.
        finalReply = (text || '(no response from model)')
          .replace(/[ \t`>*_-]*(RUN|SEND|CAM):[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim()
          || '(no response from model)';
        break;
      }
      const verb = action[1];
      const arg = (action[2] || '').trim().replace(/`+$/, '').trim();

      // /stop between the LLM deciding an action and us executing it — don't
      // run the action (a shell command may be destructive; the wait for an
      // approval tap resolves false on /stop and lands here too).
      if (signal.aborted) {
        finalReply = '⏹ Stopped.';
        break;
      }

      let toolOut: string;
      try {
        if (verb === 'RUN') {
          console.error(`[${ts0()}] agent RUN: ${arg}`);
          if (isCatastrophic(arg)) {
            toolOut = 'BLOCKED: refused as catastrophic. Do not retry this command.';
          } else if (!isReadOnlyCommand(arg)) {
            // Mutating / unknown command → require Dušan's explicit approval.
            const approved = await requestApproval(chatId, 'this command', arg);
            if (!approved) {
              toolOut = 'DENIED by user (not approved). Do not retry; suggest an alternative or ask.';
            } else {
              const r = await execShell(arg);
              toolOut = `exit ${r.code}\n${(r.stdout || r.stderr || '(no output)').slice(0, 3000)}`;
            }
          } else {
            const r = await execShell(arg);
            toolOut = `exit ${r.code}\n${(r.stdout || r.stderr || '(no output)').slice(0, 3000)}`;
          }
        } else if (verb === 'SEND') {
          console.error(`[${ts0()}] agent SEND: ${arg}`);
          const resolved = path.isAbsolute(arg) ? arg : path.join(DEFAULT_CWD, arg);
          if (!fs.existsSync(resolved)) {
            toolOut = `File not found: ${arg}`;
          } else {
            const ext = path.extname(resolved).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
              await sendPhoto(chatId, resolved);
            } else {
              await sendLocalFile(chatId, resolved);
            }
            toolOut = `Sent ${path.basename(resolved)} to the user.`;
          }
        } else { // CAM
          console.error(`[${ts0()}] agent CAM: ${arg || 'default'}`);
          const shot = captureWebcam(arg || undefined);
          await sendPhoto(chatId, shot, 'Camera snapshot');
          try { fs.unlinkSync(shot); } catch {}
          toolOut = 'Captured a webcam snapshot and sent it to the user.';
        }
      } catch (e: any) {
        toolOut = `Action failed: ${e?.message || String(e)}`;
      }

      // Feed the action + its result back and let the model continue.
      history.push({ role: 'assistant', content: `${verb}: ${arg}` });
      history.push({ role: 'user', content: `[result]\n${toolOut}` });

      if (step === AGENT_MAX_STEPS - 1) {
        const wrap = await raceAbort(provider.complete(systemPrompt, history, []), signal);
        finalReply = wrap === ABORTED
          ? '⏹ Stopped.'
          : (wrap.text || '').replace(/^(RUN|SEND|CAM):.*$/m, '').trim() || '(done)';
      }
    }
    await pushToHistory(String(chatId), { role: 'assistant', content: finalReply });
    return finalReply;
  } catch (e: any) {
    console.error(`[${ts0()}] LLM error: ${e?.message || String(e)}`);
    return `❌ AI greška: ${e?.message || 'Nepoznata greška'}. Probaj /help.`;
  } finally {
    unregisterTask(chatId, runEntry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

// ── Tool execution helpers ──────────────────────────────────────────────────

const DEFAULT_CWD = process.env.HOME ?? '/tmp';
// Track pending file operations from natural language
const pendingFileOps = new Map<string, { op: string; path: string }>();

function execShell(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd: cwd ?? DEFAULT_CWD, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        code: err ? (err.code ?? 1) : 0,
      });
    });
  });
}

function readFileTool(filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(DEFAULT_CWD, filePath);
  if (!fs.existsSync(resolved)) return `❌ File not found: ${filePath}`;
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
    return numbered.length > 3500 ? numbered.slice(0, 3500) + '\n... (truncated)' : numbered;
  } catch (e: any) {
    return `❌ Error reading: ${e.message}`;
  }
}

function listDirTool(dirPath: string): string {
  const resolved = path.isAbsolute(dirPath) ? dirPath : path.join(DEFAULT_CWD, dirPath);
  if (!fs.existsSync(resolved)) return `❌ Directory not found: ${dirPath}`;
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const lines = entries.map(e => {
      const icon = e.isDirectory() ? '📁' : '📄';
      return `${icon} ${e.name}`;
    });
    return lines.length > 50 ? lines.slice(0, 50).join('\n') + `\n... (${lines.length - 50} more)` : lines.join('\n');
  } catch (e: any) {
    return `❌ Error listing: ${e.message}`;
  }
}

function searchCodeTool(pattern: string, searchPath?: string): string {
  const resolved = searchPath
    ? (path.isAbsolute(searchPath) ? searchPath : path.join(DEFAULT_CWD, searchPath))
    : DEFAULT_CWD;
  try {
    const result = execSync(
      `rg -n --no-heading -i "${pattern.replace(/"/g, '\\"')}" "${resolved}" 2>/dev/null | head -30`,
      { timeout: 10_000, encoding: 'utf8' }
    );
    return result.trim() || `No matches for "${pattern}"`;
  } catch {
    return `No matches for "${pattern}" (or rg not installed)`;
  }
}

/** Bare text that handleCommand executes directly as a shell command
 *  (no leading slash). Shared with the reply path so shell output — like
 *  /-command output — is never read aloud as a voice note. */
function isDirectShellText(lowerText: string): boolean {
  return /^(ls|cat|pwd|whoami|date|df|du|ps|top|free|uname|which|find|grep|git|npm|node|python|curl)\b/.test(lowerText);
}

async function handleCommand(chatId: number, text: string, from: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (lower === '/start' || lower === '/help') {
    return [
      `💎 Aura Bot — Online`,
      ``,
      `Komande:`,
      `/status — Šta trenutno radi u ovom chatu (zadatak, trajanje, potvrde na čekanju) + status sistema`,
      `/tools — Lista dostupnih alata`,
      `/memory — Pregled memorije`,
      `/history — Pregled istorije razgovora`,
      `/clear — Obriši istoriju razgovora`,
      `/time — Trenutno vreme`,
      `/ping — Provera konekcije`,
      `/whoami — Ko sam ja`,
      ``,
      `💻 PC Control:`,
      `/ls <dir> — Lista direktorijuma na tvom PC-ju`,
      `/read <file> — Čitanje fajla sa tvog PC-ja`,
      `/sendfile <path> — Pošalji fajl sa tvog PC-ja na Telegram`,
      `/find <pattern> — Pronađi fajlove na tvom PC-ju`,
      `/run <cmd> — Izvrši shell komandu na tvom PC-ju`,
      `/cam — Snimi i pošalji sliku sa kamere (nadzor)`,
      `/git — Git status`,
      ``,
      `🎛 Kontrola zadatka:`,
      `/stop — Prekini zadatak koji trenutno radi u ovom chatu`,
      `/approve-all — ⚠️ Odobri SVE potvrde koje trenutno čekaju (uključujući destruktivne komande, bez ponovnog prikaza). Jednokratno — NE prebacuje u auto režim, sledeće akcije opet pitaju.`,
      ``,
      `💡 Pamtiš razgovore trajno — šta god da mi tražiš, zapamtiću to za sledeći put!`,
      `💡 Možeš da tražiš fajlove sa tvog računara i šaljiš ih sebi!`,
      ``,
      `Ili mi piši bilo šta — odgovoriću!`,
    ].join('\n');
  }

  if (lower === '/ping') return '🏓 Pong! Aura je živa i radi.';

  // ── /status — what's running in THIS chat, then bot health ───────────────
  // Pairs with /stop and /approve-all: when a task runs unattended for a
  // while, this shows what it is, how long it's been going, and whether it's
  // blocked waiting on an approval tap. The bot-health block that /status
  // always showed follows below the live-task section.
  if (lower === '/status') {
    const lines: string[] = [];
    const set = runningTasks.get(String(chatId));
    const waiting = [...pendingApprovals.values()].filter(p => p.chatId === String(chatId));
    if (set && set.size > 0) {
      lines.push(`🏃 Running task(s): ${set.size}`);
      for (const t of set) {
        const secs = Math.round((Date.now() - t.startedAt) / 1000);
        const mins = Math.floor(secs / 60);
        const dur = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
        lines.push(`  • "${t.task}" — running ${dur}`);
      }
    } else {
      lines.push('💤 No task running in this chat.');
    }
    if (waiting.length > 0) {
      lines.push(`⏳ Waiting for your ✅/❌ approval: ${waiting.length}`);
      for (const p of waiting) lines.push(`  • ${p.command.slice(0, 120)}`);
      lines.push(`(/approve-all flushes these — including destructive ones; /stop denies them.)`);
    }
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    lines.push(
      ``,
      `📊 Aura Status`,
      `Uptime: ${hours}h ${mins}m`,
      `Memory: ${mem}MB`,
      `Node: ${process.version}`,
      `Bot: @Aura_Code_bot`,
      `Status: ✅ Active`,
    );
    return lines.join('\n');
  }

  // ── /stop — abort the running task(s) for THIS chat ──────────────────────
  // Same semantics as the CLI's Esc/:stop abort: the agentic loop checks the
  // signal between steps and races it against in-flight LLM calls. Pending
  // approval prompts are denied so awaited steps unblock instead of hanging
  // until their 5-minute timeout.
  if (lower === '/stop') {
    const denied = flushApprovals(String(chatId), false);
    const set = runningTasks.get(String(chatId));
    if (!set || set.size === 0) {
      return denied > 0
        ? `⏹ Nothing running — but denied ${denied} stale pending approval(s).`
        : '⏹ Nothing is running in this chat.';
    }
    const lines: string[] = [];
    for (const t of set) {
      t.abort.abort();
      const secs = Math.round((Date.now() - t.startedAt) / 1000);
      lines.push(`  • "${t.task}" (running ${secs}s)`);
    }
    return [
      `⏹ Stopping ${set.size} task(s):`,
      ...lines,
      ...(denied > 0 ? [`Also denied ${denied} pending approval(s).`] : []),
      `Note: a shell command already executing finishes its (≤30s) run; nothing further happens after it.`,
    ].join('\n');
  }

  // ── /approve-all — one-time flush of pending confirmations ───────────────
  // ⚠️ Trust escalation: approves EVERYTHING currently waiting for a ✅/❌ tap,
  // including destructive operations, sight unseen. It does NOT change the
  // permission mode — the very next mutating command will ask again.
  if (lower === '/approve-all') {
    const n = flushApprovals(String(chatId), true);
    if (n === 0) {
      return [
        '✅ No approvals were pending.',
        '',
        '⚠️ /approve-all approves everything pending right now, including',
        'destructive operations, without showing them again. One-time flush —',
        'it does not switch to auto-approve; future actions still ask.',
      ].join('\n');
    }
    return [
      `✅ Approved ${n} pending confirmation(s) — including any destructive operations that were waiting.`,
      `This was a one-time flush; the permission mode is unchanged and future actions will still ask.`,
    ].join('\n');
  }

  if (lower === '/time') return `🕐 ${new Date().toLocaleString('sr-RS', { timeZone: 'Europe/Belgrade' })}`;

  if (lower === '/whoami') {
    return [
      `💎 Ja sam Aura — agent.`,
      ``,
      `Framework: Aura (starogrčki: ona koja deluje)`,
      `Karakter: Precizna, carska, self-aware`,
      `Moto: "I don't try. I verify."`,
      `Builder: Dušan Milosavljević`,
      `Alati: 22`,
      `Testovi: 838+ passing`,
      `Verzija: v0.7.2 (Aura)`,
    ].join('\n');
  }

  if (lower === '/tools') {
    return [
      `🔧 Dostupni alati:`,
      ``,
      `📁 /ls <dir> — lista direktorijuma`,
      `📄 /read <file> — čitanje fajla`,
      `🔍 /search <pattern> — pretraga koda`,
      `⚡ /run <cmd> — shell komanda`,
      `🌿 /git — git status`,
      `🧠 /memory — pregled memorije`,
    ].join('\n');
  }

  // ── Tool commands ──────────────────────────────────────────────────────

  if (lower.startsWith('/ls')) {
    const dir = text.slice(3).trim() || '.';
    return `📁 ${dir}:\n${listDirTool(dir)}`;
  }

  if (lower.startsWith('/read')) {
    const file = text.slice(5).trim();
    if (!file) return '❌ Usage: /read <file>';
    return readFileTool(file);
  }

  if (lower.startsWith('/search')) {
    const pattern = text.slice(7).trim();
    if (!pattern) return '❌ Usage: /search <pattern>';
    return `🔍 Results for "${pattern}":\n${searchCodeTool(pattern)}`;
  }

  if (lower.startsWith('/run')) {
    const cmd = text.slice(4).trim();
    if (!cmd) return '❌ Usage: /run <command>';

    if (isCatastrophic(cmd)) {
      return '🚫 Blocked: extremely dangerous command detected. This would destroy your system.';
    }
    // Mutating commands need an explicit ✅ approval; read-only run immediately.
    if (!isReadOnlyCommand(cmd)) {
      const approved = await requestApproval(chatId, 'this command', cmd);
      if (!approved) return '❌ Denied — command not run.';
    }

    const result = await execShell(cmd);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${cmd}\n${result.code === 0 ? '✅' : '❌'} exit ${result.code}\n${truncated}`;
  }

  if (lower === '/git') {
    const result = await execShell('git status --short && echo "---" && git log --oneline -5');
    return `🌿 Git:\n${result.stdout || '(not a git repo)'}`;
  }

  if (lower.startsWith('/memory')) {
    const memDir = path.join(os.homedir(), '.aura', 'memory');
    if (!fs.existsSync(memDir)) return '🧠 Nema memorije.';
    try {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.json'));
      if (files.length === 0) return '🧠 Memorija prazna.';
      const lines = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(memDir, f), 'utf8'));
        return `📁 ${f.replace('.json', '')}: ${Object.keys(data).length} ključeva`;
      });
      return `🧠 Memorija:\n${lines.join('\n')}`;
    } catch {
      return '🧠 Greška pri čitanju memorije.';
    }
  }

  if (lower === '/history' || lower.startsWith('/history')) {
    const history = getChatHistory(String(chatId));
    if (history.length === 0) return '📜 Nema istorije razgovora. Započni razgovor i ja ću ga pamtiti!';
    const lines = history.slice(-10).map((m, i) => {
      const role = m.role === 'user' ? '👤 Ti' : '🤖 Aura';
      const content = (m.role === 'tool_result') ? '[alat]' : (typeof m.content === 'string' ? m.content.slice(0, 100) : '[non-text]');
      return `${role}: ${content}${content.length >= 100 ? '...' : ''}`;
    });
    return `📜 Poslednjih 10 poruka (ukupno ${history.length}):\n${lines.join('\n')}\n\n💡 Svi razgovori se čuvaju trajno — pamtim šta si mi rekao čak i ako me resetuješ.`;
  }

  if (lower === '/clear') {
    chatHistory.delete(String(chatId));
    const filePath = getSessionFile(String(chatId));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return '🗑️ Istorija razgovora obrisana. Možemo početi iz početka!';
  }

  // ── File sending from PC ─────────────────────────────────────────────────────

  if (lower.startsWith('/sendfile') || lower.startsWith('/send')) {
    const filePath = text.startsWith('/sendfile ') ? text.slice(9).trim() : text.slice(5).trim();
    if (!filePath) return '❌ Usage: /sendfile <path> or /send <path>';

    const resolved = path.isAbsolute(filePath) ? filePath : path.join(DEFAULT_CWD, filePath);
    if (!fs.existsSync(resolved)) {
      return `❌ File not found: ${filePath}`;
    }

    try {
      const stats = fs.statSync(resolved);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      await sendMessage(chatId, `📤 Sending file: ${path.basename(resolved)} (${sizeMB}MB)`);
      const ext = path.extname(resolved).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        await sendPhoto(chatId, resolved);
      } else {
        await sendLocalFile(chatId, resolved);
      }
      return `✅ File sent: ${path.basename(resolved)}`;
    } catch (e: any) {
      return `❌ Error sending file: ${e.message}`;
    }
  }

  // /cam or /photo — capture a webcam snapshot and send it (surveillance).
  if (lower === '/cam' || lower === '/photo' || lower.startsWith('/cam ') || lower.startsWith('/photo ')) {
    const device = text.split(/\s+/)[1] || '/dev/video0';
    try {
      await sendMessage(chatId, '📷 Capturing snapshot…');
      const shot = captureWebcam(device);
      await sendPhoto(chatId, shot, `Snapshot ${new Date().toLocaleString()}`);
      try { fs.unlinkSync(shot); } catch {}
      return '✅ Snapshot sent.';
    } catch (e: any) {
      return `❌ Camera error: ${e.message}`;
    }
  }

  if (lower.startsWith('/find')) {
    const pattern = text.slice(5).trim();
    if (!pattern) return '❌ Usage: /find <pattern>';

    try {
      const searchDir = DEFAULT_CWD;
      const cmd = `find "${searchDir}" -name "*${pattern}*" -type f 2>/dev/null | head -20`;
      const result = await execShell(cmd);
      const files = result.stdout.trim().split('\n').filter(f => f);

      if (files.length === 0 || files[0] === '') {
        return `🔍 No files found matching "${pattern}"`;
      }

      const lines = files.map(f => {
        const name = path.basename(f);
        const rel = path.relative(DEFAULT_CWD, f);
        const stats = fs.statSync(f);
        const size = (stats.size / 1024).toFixed(1) + 'KB';
        return `📄 ${name} (${size})\n   ${rel}`;
      });

      return `🔍 Found ${files.length} file(s):\n${lines.join('\n')}\n\n💡 Use /sendfile <path> to get any file`;
    } catch (e: any) {
      return `❌ Search error: ${e.message}`;
    }
  }

  if (lower.startsWith('/pwd')) {
    return `📁 Current directory: ${DEFAULT_CWD}`;
  }

  if (lower === '/home' || lower.startsWith('/cd ')) {
    if (lower === '/home') {
      return `📁 Home directory: ${process.env.HOME}`;
    }
    const dir = text.slice(4).trim();
    if (!fs.existsSync(dir)) return `❌ Directory not found: ${dir}`;
    // Note: changing DEFAULT_CWD would require restarting, so just show info
    return `💡 To change working directory, restart bot with HOME set or use absolute paths`;
  }

  // Default: try to interpret as a shell command if it looks like one
  if (isDirectShellText(lower)) {
    const result = await execShell(text);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${text}\n${truncated}`;
  }

  // Everything else → the agentic LLM. It decides for itself when to run a
  // command (via `RUN:`), so we no longer keyword-match "send/find/run/search"
  // in free text. Those greedy matchers hijacked normal conversation — e.g. a
  // message that merely contained "find" or "search" got treated as a file
  // search ("No files found matching …"). Explicit /-commands still work above.
  return await chatWithLLM(String(chatId), text, from);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main polling loop
// ─────────────────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function poll(): Promise<void> {
  let offset = loadOffset();

  console.log(`[${ts()}] 💎 Aura Telegram Bot started`);
  console.log(`   Bot: @Aura_Code_bot`);
  console.log(`   Offset: ${offset}`);
  console.log(`   Long-polling Telegram (30s)…`);
  console.log('');


  // Load chat history from disk on startup — enables conversation continuity across restarts
  await initializeChatHistory();
  // Delete any webhook on startup — webhooks and getUpdates conflict (409)
  try {
    await apiPost('deleteWebhook', { drop_pending_updates: false });
    console.log(`[${ts()}]   Webhook cleared (polling mode)`);
  } catch (e: any) {
    console.error(`[${ts()}]   ⚠️ Webhook clear error: ${e.message}`);
  }

  // Clear old updates on first run
  if (offset === 0) {
    try {
      const updates = await apiGet('getUpdates', { offset: '0', limit: '100' });
      if (updates.length > 0) {
        offset = updates[updates.length - 1].update_id + 1;
        saveOffset(offset);
        console.log(`[${ts()}]   Cleared ${updates.length} old update(s), offset: ${offset}`);
      }
    } catch (e: any) {
      console.error(`[${ts()}]   ⚠️ Clear error: ${e.message}`);
    }
  }

  let consecutiveErrors = 0;
  let lastHeartbeat = Date.now();
  const HEARTBEAT_MS = 5 * 60_000; // log "alive" every 5 min

  while (true) {
    try {
      const updates = await apiGet('getUpdates', {
        offset: String(offset),
        limit: '1',
        timeout: '30', // long-poll up to 30s — reduces API calls
      });

      consecutiveErrors = 0;

      for (const update of updates) {
        offset = update.update_id + 1;
        saveOffset(offset);

        // Approval button taps (✅/❌) arrive as callback_query, not messages.
        const cb = update.callback_query;
        if (cb) {
          const cbAuthorized = isAuthorized(cb.from?.id);
          const data: string = cb.data ?? '';
          const m = data.match(/^(ok|no):(.+)$/);
          let note = 'Expired or already handled.';
          if (cbAuthorized && m) {
            const pending = pendingApprovals.get(m[2]);
            if (pending) {
              pendingApprovals.delete(m[2]);
              const approved = m[1] === 'ok';
              pending.resolve(approved);
              note = approved ? '✅ Approved' : '❌ Denied';
            }
          } else if (!cbAuthorized) {
            note = '🚫 Not authorized.';
          }
          // Acknowledge the tap (removes the spinner) and update the message.
          try { await apiPost('answerCallbackQuery', { callback_query_id: cb.id, text: note }); } catch { /* ignore */ }
          try {
            await apiPost('editMessageText', {
              chat_id: cb.message?.chat?.id,
              message_id: cb.message?.message_id,
              text: `${cb.message?.text ?? ''}\n\n${note}`,
            });
          } catch { /* ignore */ }
          continue;
        }

        const msg = update.message;
        if (!msg) continue;

        const chatId = msg.chat.id;
        const from = msg.from?.first_name ?? msg.from?.username ?? 'unknown';

        // AUTH GATE — refuse anyone not on the allowlist. The bot controls the
        // PC, so this is the primary security boundary.
        if (!isAuthorized(msg.from?.id)) {
          console.error(`[${ts()}] 🚫 Unauthorized ${from} (id ${msg.from?.id}) — refused: ${(msg.text ?? '(non-text)').slice(0, 60)}`);
          try { await sendMessage(chatId, '🚫 Not authorized.'); } catch { /* ignore */ }
          continue;
        }

        // Handle the message WITHOUT blocking the poll loop. A command may wait
        // on an approval tap (requestApproval), and that tap arrives as a later
        // update — if we awaited the handler here, the loop couldn't fetch it
        // (deadlock). So process each message as a detached task; the loop keeps
        // polling and can deliver the callback that unblocks it.
        void (async () => {
          try {
            let text: string = msg.text ?? '';
            let cameFromVoice = false;
            const voice = msg.voice || msg.audio;
            if (!text && voice?.file_id) {
              cameFromVoice = true;
              const audioPath = await downloadTelegramFile(voice.file_id);
              text = await transcribeFile(audioPath);
              try { fs.unlinkSync(audioPath); } catch {}
              console.log(`[${ts()}] 🎤 [${from}] (voice): ${text}`);
              if (text) await sendMessage(chatId, `🎤 “${text}”`);
            }
            if (!text) return;
            if (!cameFromVoice) console.log(`[${ts()}] 📩 [${from}]: ${text}`);

            const lower = text.toLowerCase().trim();
            const conversational = !lower.startsWith('/') && !isDirectShellText(lower);
            const response = await handleCommand(chatId, text, from);
            await sendMessage(chatId, response);
            // Voice note alongside the text, per the audio-reply policy:
            // voice-in always speaks back; 'auto' also speaks substantial
            // conversational replies (task summaries), never command output.
            if (shouldSendAudio({
              mode: AUDIO_MODE, cameFromVoice, conversational,
              length: response.length, minChars: AUDIO_MIN_CHARS,
            })) {
              const spoken = stripForSpeech(response);
              if (spoken) {
                let voiceSent = false;
                let voiceError = '';
                // Path 1: Groq playai-tts via curl — returns OGG natively (no
                // ffmpeg step needed). This is the tested, reliable path.
                const groqKey = getApiKey('GROQ_API_KEY', 'groq_api_key');
                if (groqKey) {
                  try {
                    const ogg = await textToSpeech(spoken, groqKey);
                    await sendVoiceMessage(TOKEN, chatId, ogg);
                    voiceSent = true;
                  } catch (e: any) {
                    voiceError = e?.message || String(e);
                    console.error(`[${ts()}] ⚠️ Groq TTS failed: ${voiceError}`);
                  }
                }
                // Path 2 (fallback): MiMo TTS → WAV → ffmpeg Opus.
                if (!voiceSent) {
                  try {
                    const wav = await synthesizeSpeech(spoken);
                    await sendVoice(chatId, wav);
                    voiceSent = true;
                  } catch (e: any) {
                    voiceError = voiceError || (e?.message || String(e));
                    console.error(`[${ts()}] ⚠️ MiMo TTS failed: ${voiceError}`);
                  }
                }
                if (!voiceSent) {
                  // Tell the user why there's no voice note instead of
                  // silently swallowing the failure.
                  console.error(`[${ts()}] ⚠️ Voice reply failed entirely: ${voiceError}`);
                }
              }
            }
            console.log(`[${ts()}] 📤 Replied to ${from}`);
          } catch (e: any) {
            console.error(`[${ts()}] ❌ Reply error: ${e.message}`);
            try { await sendMessage(chatId, `❌ Greška: ${e.message}`); } catch { /* give up */ }
          }
        })();
      }

      // Periodic heartbeat
      if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log(`[${ts()}] ❤️ Alive (uptime ${h}h${m}m, heap ${mem}MB)`);
        lastHeartbeat = Date.now();
      }
    } catch (e: any) {
      consecutiveErrors++;
      const msg = e?.message || String(e);
      const isConflict = msg.includes('409') || msg.includes('Conflict');
      const kind = msg.includes('timeout') ? 'timeout' : isConflict ? 'conflict' : 'api';
      console.error(`[${ts()}] ⚠️ Poll error (${consecutiveErrors}, ${kind}): ${msg}`);
      if (consecutiveErrors > 10) {
        console.error(`[${ts()}] 💀 Too many errors, waiting 30s…`);
        await new Promise(r => setTimeout(r, 30000));
        consecutiveErrors = 0;
      } else if (isConflict) {
        // 409 Conflict: another poll is active — wait 5s for it to settle
        await new Promise(r => setTimeout(r, 5000));
      } else {
        // Backoff: 2s → 4s → 8s … capped at 30s
        const delay = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), 30000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

// Survive unexpected crashes — log and keep polling
process.on('uncaughtException', (e) => {
  console.error(`[${ts()}] 💥 Uncaught exception:`, e.message ?? e);
  // Don't exit — the polling loop handles errors internally
});
process.on('unhandledRejection', (reason: any) => {
  console.error(`[${ts()}] 💥 Unhandled rejection:`, reason?.message ?? String(reason));
});

poll().catch(e => {
  console.error(`[${ts()}] Fatal:`, e);
  process.exit(1);
});

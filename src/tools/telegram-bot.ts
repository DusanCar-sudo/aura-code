#!/usr/bin/env node
// Aura Telegram Bot — listens for messages, processes them, responds
// Uses https module instead of fetch (Node fetch broken on this system)
// Usage: npx tsx src/tools/telegram-bot.ts

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { exec, execSync } from 'child_process';
import { createProvider, registerCustomProviders } from '../providers/factory.js';
import { loadProjectConfig } from '../config/project-config.js';
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
  const memDir = path.join(os.homedir(), '.aura', 'memory');
  const lines: string[] = [];
  
  // Load key identity namespaces
  for (const ns of ['user', 'default']) {
    const file = path.join(memDir, `${ns}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const identityKeys = ['creator', 'creator-full', 'user-name', 'user-id', 'user-role'];
      for (const key of identityKeys) {
        if (data[key]?.value) {
          lines.push(`${key}: ${data[key].value}`);
        }
      }
    } catch { /* skip */ }
  }

  if (lines.length === 0) return '';
  return '\n## O korisniku (iz memorije)\n' + lines.join('\n');
}

// Build system prompt once on first use — includes user identity from memory
function buildSystemPrompt(): string {
  if (!_identityBlock) {
    _identityBlock = loadIdentityFromMemory();
  }
  const base = config.system_prompt || [
    'Ti si Aura — AI asistent. Odgovaraš kratko, precizno, na srpskom.',
    'Korisnik je Dušan — tvoj kreator. Zovi ga po imenu kad je prirodno.',
    'Poznaješ ga dobro — on te napravio. Budi topla ali profesionalna.',
    'Ako pitaš za pomoć reci "/help za komande".',
    'Ne izmišljaj — budi iskrena ako ne znaš.',
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

async function chatWithLLM(chatId: string, userMessage: string, userName: string): Promise<string> {
  const provider = getChatProvider();
  const systemPrompt = buildSystemPrompt();

  // Build history: recent context + the new message
  const recent = getChatHistory(chatId).slice(-(CHAT_HISTORY_MAX - 1));
  const history: HistoryMessage[] = [...recent, { role: 'user', content: userMessage }];

  await pushToHistory(String(chatId), { role: 'user', content: userMessage });

  console.error(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] LLM: sending to ${provider.name}/${provider.model} (history: ${history.length} msgs)`);
  try {
    const response = await provider.complete(systemPrompt, history, []);
    const reply = response.text || '(no response from model)';
    await pushToHistory(String(chatId), { role: 'assistant', content: reply });
    return reply;
  } catch (e: any) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.error(`[${now}] LLM error: ${e?.message || String(e)}`);
    return `❌ AI greška: ${e?.message || 'Nepoznata greška'}. Probaj /help.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

// ── Tool execution helpers ──────────────────────────────────────────────────

const DEFAULT_CWD = process.env.HOME ?? '/tmp';

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

async function handleCommand(chatId: number, text: string, from: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (lower === '/start' || lower === '/help') {
    return [
      `💎 Aura Bot — Online`,
      ``,
      `Komande:`,
      `/status — Status sistema`,
      `/tools — Lista dostupnih alata`,
      `/memory — Pregled memorije`,
      `/history — Pregled istorije razgovora`,
      `/clear — Obriši istoriju razgovora`,
      `/time — Trenutno vreme`,
      `/ping — Provera konekcije`,
      `/whoami — Ko sam ja`,
      `/ls <dir> — Lista direktorijuma`,
      `/read <file> — Čitanje fajla`,
      `/search <pattern> — Pretraga koda`,
      `/run <cmd> — Izvršavanje shell komande`,
      `/git — Git status`,
      ``,
      `💡 Pamtiš razgovore trajno — šta god da mi tražiš, zapamtiću to za sledeći put!`,
      ``,
      `Ili mi piši bilo šta — odgovoriću!`,
    ].join('\n');
  }

  if (lower === '/ping') return '🏓 Pong! Aura je živa i radi.';

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

  if (lower === '/status') {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    return [
      `📊 Aura Status`,
      `Uptime: ${hours}h ${mins}m`,
      `Memory: ${mem}MB`,
      `Node: ${process.version}`,
      `Bot: @Aura_Code_bot`,
      `Status: ✅ Active`,
      `Version: v0.7.2`,
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
    // Safety: block dangerous commands
    const dangerous = ['rm -rf', 'mkfs', 'dd if=', 'fork bomb', 'shutdown', 'reboot'];
    if (dangerous.some(d => cmd.toLowerCase().includes(d))) {
      return '🚫 Blocked: dangerous command detected.';
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

  // Default: try to interpret as a shell command if it looks like one
  const looksLikeCommand = /^(ls|cat|pwd|whoami|date|df|du|ps|top|free|uname|which|find|grep|git|npm|node|python|curl)\b/.test(lower);
  if (looksLikeCommand) {
    const result = await execShell(text);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${text}\n${truncated}`;
  }

  // Default: ask the LLM
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

        const msg = update.message;
        if (!msg || !msg.text) continue;

        const chatId = msg.chat.id;
        const text = msg.text;
        const from = msg.from?.first_name ?? msg.from?.username ?? 'unknown';

        console.log(`[${ts()}] 📩 [${from}]: ${text}`);

        try {
          const response = await handleCommand(chatId, text, from);
          await sendMessage(chatId, response);
          console.log(`[${ts()}] 📤 Replied to ${from}`);
        } catch (e: any) {
          console.error(`[${ts()}] ❌ Reply error: ${e.message}`);
          try {
            await sendMessage(chatId, `❌ Greška: ${e.message}`);
          } catch { /* give up */ }
        }
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

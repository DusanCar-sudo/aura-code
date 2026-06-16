#!/usr/bin/env node
// Aura Telegram Bot — listens for messages, processes them, responds
// Uses curl for API calls (Node https.request ETIMEDOUT on this system)
// Usage: npx tsx src/tools/telegram-bot.ts

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ─────────────────────────────────────────────────────────────────────────────
// LLM Integration (Xiaomi MiMo via curl)
// ─────────────────────────────────────────────────────────────────────────────

const MIMO_KEY = process.env.XIAOMI_API_KEY ?? '';
const MIMO_BASE_URL = process.env.XIAOMI_BASE_URL ?? 'https://token-plan-sgp.xiaomimimo.com/v1';
const MIMO_MODEL = 'mimo-v2.5-pro';
const CONVERSATIONS_FILE = path.join(os.homedir(), '.aura', 'telegram-conversations.json');

interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

function loadConversations(): Record<number, ConversationEntry[]> {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveConversations(convos: Record<number, ConversationEntry[]>): void {
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(convos, null, 2), 'utf8');
}

const conversations: Record<number, ConversationEntry[]> = loadConversations();

function askMiMo(chatId: number, userMessage: string): string {
  if (!MIMO_KEY) return '❌ XIAOMI_API_KEY not set. Cannot call MiMo.';

  // Init conversation history for this chat
  if (!conversations[chatId]) {
    conversations[chatId] = [
      { role: 'system' as any, content: `You are Aura — a precise, efficient AI coding agent. You are communicating via Telegram with your creator Dušan. Be concise, helpful, and direct. You can discuss code, answer questions, give advice. If asked to run commands or check files, suggest using the /run, /read, /ls commands. Speak in the language the user speaks (Serbian or English). Keep responses short and practical for mobile reading.` } as any,
    ];
  }

  // Add user message
  conversations[chatId].push({ role: 'user', content: userMessage });

  // Keep last 20 messages to stay within token limits
  const recentMessages = conversations[chatId].slice(-20);

  const body = JSON.stringify({
    model: MIMO_MODEL,
    max_tokens: 2048,
    messages: recentMessages,
  });

  try {
    const result = execSync(
      `curl -s -X POST ${MIMO_BASE_URL}/chat/completions ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${MIMO_KEY}" ` +
      `-d '${body.replace(/'/g, "'\\''")}'`,
      { timeout: 60_000, encoding: 'utf8' }
    );

    const parsed = JSON.parse(result);

    if (parsed.error) {
      return `❌ MiMo error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`;
    }

    const assistantText = parsed.choices?.[0]?.message?.content ?? 'No response from MiMo.';

    // Save assistant reply to history
    conversations[chatId].push({ role: 'assistant', content: assistantText });
    saveConversations(conversations);

    return assistantText;
  } catch (e: any) {
    return `❌ MiMo call failed: ${e.message}`;
  }
}

function clearConversation(chatId: number): void {
  delete conversations[chatId];
  saveConversations(conversations);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  bot_token: string;
  default_chat_id?: string;
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
// API helpers via curl (Node https.request ETIMEDOUT on this system)
// ─────────────────────────────────────────────────────────────────────────────

const config = loadConfig();
const TOKEN = config.bot_token;
const OFFSET_FILE = path.join(os.homedir(), '.aura', 'telegram.offset');

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

function curlPost(method: string, body?: Record<string, unknown>): any {
  const data = body ? JSON.stringify(body) : '';
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const escaped = data.replace(/'/g, "'\\''");
  const result = execSync(
    `curl -s -X POST -H "Content-Type: application/json" -d '${escaped}' "${url}"`,
    { timeout: 30_000, encoding: 'utf8' }
  );
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new Error(`Telegram: ${parsed.description} (${parsed.error_code})`);
  return parsed.result;
}

function curlGet(method: string, params?: Record<string, string>): any {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const url = `https://api.telegram.org/bot${TOKEN}/${method}${qs}`;
  const result = execSync(`curl -s "${url}"`, { timeout: 30_000, encoding: 'utf8' });
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new Error(`Telegram: ${parsed.description} (${parsed.error_code})`);
  return parsed.result;
}

function sendMessage(chatId: string | number, text: string): void {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    curlPost('sendMessage', { chat_id: chatId, text: chunk });
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
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CWD = process.env.HOME ?? '/tmp';

function execShell(command: string, cwd?: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(command, {
      cwd: cwd ?? DEFAULT_CWD,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      code: err.status ?? 1,
    };
  }
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

function handleCommand(chatId: number, text: string, from: string): string {
  const lower = text.toLowerCase().trim();

  if (lower === '/start' || lower === '/help') {
    return [
      `💎 Aura Bot — Online`,
      ``,
      `Commands:`,
      `/status — System status`,
      `/tools — Available tools`,
      `/memory — Memory overview`,
      `/time — Current time`,
      `/ping — Connection check`,
      `/whoami — About me`,
      `/ls <dir> — List directory`,
      `/read <file> — Read file`,
      `/search <pattern> — Search code`,
      `/run <cmd> — Run shell command`,
      `/git — Git status`,
      `/clear — Clear conversation history`,
      ``,
      `Or just write anything — I'll respond via Claude!`,
    ].join('\n');
  }

  if (lower === '/ping') return '🏓 Pong! Aura is alive and running.';

  if (lower === '/time') return `🕐 ${new Date().toLocaleString('sr-RS', { timeZone: 'Europe/Belgrade' })}`;

  if (lower === '/whoami') {
    return [
      `💎 I am Aura — an agent.`,
      ``,
      `Framework: Aura (Ancient Greek: she who acts)`,
      `Character: Precise, imperial, self-aware`,
      `Motto: "I don't try. I verify."`,
      `Builder: Dušan Milosavljević`,
      `Tools: 22`,
      `Tests: 734+ passing`,
      `Version: v0.3.0 (Aura rebrand)`,
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
      `Bot: @Praktessruby_bot`,
      `Status: ✅ Active`,
      `Version: v0.3.0`,
    ].join('\n');
  }

  if (lower === '/tools') {
    return [
      `🔧 Available tools:`,
      ``,
      `📁 /ls <dir> — list directory`,
      `📄 /read <file> — read file`,
      `🔍 /search <pattern> — search code`,
      `⚡ /run <cmd> — shell command`,
      `🌿 /git — git status`,
      `🧠 /memory — memory overview`,
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
    const dangerous = ['rm -rf', 'mkfs', 'dd if=', 'fork bomb', 'shutdown', 'reboot'];
    if (dangerous.some(d => cmd.toLowerCase().includes(d))) {
      return '🚫 Blocked: dangerous command detected.';
    }
    const result = execShell(cmd);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${cmd}\n${result.code === 0 ? '✅' : '❌'} exit ${result.code}\n${truncated}`;
  }

  if (lower === '/git') {
    const result = execShell('git status --short && echo "---" && git log --oneline -5');
    return `🌿 Git:\n${result.stdout || '(not a git repo)'}`;
  }

  if (lower.startsWith('/memory')) {
    const memDir = path.join(os.homedir(), '.aura', 'memory');
    if (!fs.existsSync(memDir)) return '🧠 No memory found.';
    try {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.json'));
      if (files.length === 0) return '🧠 Memory empty.';
      const lines = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(memDir, f), 'utf8'));
        return `📁 ${f.replace('.json', '')}: ${Object.keys(data).length} keys`;
      });
      return `🧠 Memory:\n${lines.join('\n')}`;
    } catch {
      return '🧠 Error reading memory.';
    }
  }

  if (lower === '/clear') {
    clearConversation(chatId);
    return '🧹 Conversation cleared. Starting fresh.';
  }

  // Default: try to interpret as a shell command if it looks like one
  const looksLikeCommand = /^(ls|cat|pwd|whoami|date|df|du|ps|top|free|uname|which|find|grep|git|npm|node|python|curl)\b/.test(lower);
  if (looksLikeCommand) {
    const result = execShell(text);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${text}\n${truncated}`;
  }

  // Default: send to MiMo for real conversation
  return askMiMo(chatId, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main polling loop
// ─────────────────────────────────────────────────────────────────────────────

function poll(): void {
  let offset = loadOffset();

  console.log('💎 Aura Telegram Bot started');
  console.log(`   Bot: @Praktessruby_bot`);
  console.log(`   Offset: ${offset}`);
  console.log(`   Polling every 3 seconds...`);
  console.log('');

  // Clear old updates on first run
  if (offset === 0) {
    try {
      const updates = curlGet('getUpdates', { offset: '0', limit: '100' });
      if (updates.length > 0) {
        offset = updates[updates.length - 1].update_id + 1;
        saveOffset(offset);
        console.log(`   Cleared ${updates.length} old update(s), offset: ${offset}`);
      }
    } catch (e: any) {
      console.error(`   ⚠️ Clear error: ${e.message}`);
    }
  }

  let consecutiveErrors = 0;

  while (true) {
    try {
      const updates = curlGet('getUpdates', {
        offset: String(offset),
        limit: '100',
        timeout: '3',
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

        console.log(`📩 [${from}]: ${text}`);

        try {
          const response = handleCommand(chatId, text, from);
          sendMessage(chatId, response);
          console.log(`📤 Replied to ${from}`);
        } catch (e: any) {
          console.error(`❌ Reply error: ${e.message}`);
          try {
            sendMessage(chatId, `❌ Error: ${e.message}`);
          } catch { /* give up */ }
        }
      }
    } catch (e: any) {
      consecutiveErrors++;
      console.error(`⚠️ Poll error (${consecutiveErrors}): ${e.message}`);
      if (consecutiveErrors > 10) {
        console.error('💀 Too many errors, waiting 30s...');
        execSync('sleep 30');
        consecutiveErrors = 0;
      } else {
        execSync('sleep 3');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

poll();

#!/usr/bin/env node
// Praktess Telegram Bot — listens for messages, processes them, responds
// Uses https module instead of fetch (Node fetch broken on this system)
// Usage: npx tsx src/tools/telegram-bot.ts

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

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
// HTTPS helper (no fetch dependency)
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

function apiPost(method: string, body?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
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
        } catch (e) {
          reject(new Error(`Parse error: ${responseData.slice(0, 100)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(35000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (data) req.write(data);
    req.end();
  });
}

function apiGet(method: string, params?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/${method}${qs}`,
      method: 'GET',
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
        } catch (e) {
          reject(new Error(`Parse error: ${responseData.slice(0, 100)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(35000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
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
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

// ── Tool execution helpers ──────────────────────────────────────────────────

const DEFAULT_CWD = process.env.HOME ?? '/tmp';

function execShell(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
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
    const result = require('child_process').execSync(
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
      `/time — Trenutno vreme`,
      `/ping — Provera konekcije`,
      `/whoami — Ko sam ja`,
      `/ls <dir> — Lista direktorijuma`,
      `/read <file> — Čitanje fajla`,
      `/search <pattern> — Pretraga koda`,
      `/run <cmd> — Izvršavanje shell komande`,
      `/git — Git status`,
      ``,
      `Ili mi piši bilo šta — odgovoriću!`,
    ].join('\n');
  }

  if (lower === '/ping') return '🏓 Pong! Aura je živa i radi.';

  if (lower === '/time') return `🕐 ${new Date().toLocaleString('sr-RS', { timeZone: 'Europe/Belgrade' })}`;

  if (lower === '/whoami') {
    return [
      `💎 Ja sam Aura — Praktess agent.`,
      ``,
      `Framework: Praktess (starogrčki: ona koja deluje)`,
      `Karakter: Precizna, carska, self-aware`,
      `Moto: "I don't try. I verify."`,
      `Builder: Dušan Milosavljević`,
      `Alati: 22`,
      `Testovi: 838+ passing`,
      `Verzija: v0.3.0 (Aura rebrand)`,
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

  // Default: try to interpret as a shell command if it looks like one
  const looksLikeCommand = /^(ls|cat|pwd|whoami|date|df|du|ps|top|free|uname|which|find|grep|git|npm|node|python|curl)\b/.test(lower);
  if (looksLikeCommand) {
    const result = await execShell(text);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${text}\n${truncated}`;
  }

  // Default: acknowledge and echo
  return [
    `💬 Primljeno od ${from}:`,
    `"${text}"`,
    ``,
    `Vreme: ${new Date().toLocaleString('sr-RS', { timeZone: 'Europe/Belgrade' })}`,
    ``,
    `Probaj /help za liste komandi.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main polling loop
// ─────────────────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  let offset = loadOffset();

  console.log('💎 Praktess Telegram Bot started');
  console.log(`   Bot: @Praktessruby_bot`);
  console.log(`   Offset: ${offset}`);
  console.log(`   Polling every 3 seconds...`);
  console.log('');

  // Clear old updates on first run
  if (offset === 0) {
    try {
      const updates = await apiGet('getUpdates', { offset: '0', limit: '100' });
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
      const updates = await apiGet('getUpdates', {
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
          const response = await handleCommand(chatId, text, from);
          await sendMessage(chatId, response);
          console.log(`📤 Replied to ${from}`);
        } catch (e: any) {
          console.error(`❌ Reply error: ${e.message}`);
          try {
            await sendMessage(chatId, `❌ Greška: ${e.message}`);
          } catch { /* give up */ }
        }
      }
    } catch (e: any) {
      consecutiveErrors++;
      console.error(`⚠️ Poll error (${consecutiveErrors}): ${e.message}`);
      if (consecutiveErrors > 10) {
        console.error('💀 Too many errors, waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
        consecutiveErrors = 0;
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

poll().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

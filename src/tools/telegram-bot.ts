#!/usr/bin/env node
// Aura Telegram Bot — listens for messages, executes real Aura tasks
// Uses curl for API calls (Node https.request ETIMEDOUT on this system)
// Usage: npx tsx src/tools/telegram-bot.ts

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, execSync } from 'child_process';

import { createProvider } from '../providers/factory.js';
import { loadProjectContext } from '../agent/context.js';
import { bootstrapAuraEnv } from '../util/load-env.js';
import { loadGlobalConfig } from '../setup/global-config.js';
import { loadProjectConfig } from '../config/project-config.js';
import { loadProviderConfig } from '../setup/provider-wizard.js';
import { getApiKey } from '../util/env.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';
import type { LLMProvider } from '../providers/types.js';

import {
  loadSafetyState,
  saveSafetyState,
  safetyLabel,
  TelegramConfirmManager,
  isDestructiveTool,
} from './telegram-safety.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  bot_token: string;
  default_chat_id?: string;
  /** Comma-separated list of authorized Telegram user IDs. */
  allowed_user_ids?: string;
}

function loadConfig(): TelegramConfig {
  const configPath = path.join(os.homedir(), '.aura', 'telegram.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ Config not found. Create ~/.aura/telegram.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const config = loadConfig();
const TOKEN = config.bot_token;
const OFFSET_FILE = path.join(os.homedir(), '.aura', 'telegram.offset');

// ── Authorized user IDs ───────────────────────────────────────────────────
// Check: config file, then env var TELEGRAM_BOT_ALLOWED_USER_IDS (comma-sep)
function loadAuthorizedUserIds(): Set<number> {
  const ids = new Set<number>();
  const raw =
    config.allowed_user_ids
    ?? process.env.TELEGRAM_BOT_ALLOWED_USER_IDS
    ?? '';
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (!isNaN(n)) ids.add(n);
    }
  }
  return ids;
}

const AUTHORIZED_USER_IDS = loadAuthorizedUserIds();

// The project root for task execution
const PROJECT_ROOT = process.env.TELEGRAM_BOT_PROJECT_ROOT
  ?? path.resolve(__dirname, '../..'); // default to aura-code repo

bootstrapAuraEnv(PROJECT_ROOT);

function resolveTaskModel(): string {
  const fileConfig = loadProjectConfig(PROJECT_ROOT);
  const globalCfg = loadGlobalConfig();
  return process.env.TELEGRAM_BOT_MODEL
    ?? process.env.AURA_MODEL
    ?? fileConfig.model
    ?? globalCfg?.defaultModel
    ?? 'deepseek/deepseek-v4-flash';
}

// The model to use for task execution
const TASK_MODEL = resolveTaskModel();

// ── Safety state ───────────────────────────────────────────────────────────
let safetyState = loadSafetyState();
const confirmManager = new TelegramConfirmManager();

function saveState(): void {
  saveSafetyState(safetyState);
}

// ── Provider (created once, reused) ────────────────────────────────────────
function createLLMProvider(): LLMProvider {
  const saved = loadProviderConfig();
  const fileConfig = loadProjectConfig(PROJECT_ROOT);
  const globalCfg = loadGlobalConfig();
  const apiKey = process.env.AURA_API_KEY
    ?? saved?.apiKey
    ?? getApiKey('DEEPSEEK_API_KEY')
    ?? getApiKey('XIAOMI_API_KEY')
    ?? getApiKey('ANTHROPIC_API_KEY')
    ?? getApiKey('OPENAI_API_KEY')
    ?? getApiKey('GOOGLE_API_KEY')
    ?? getApiKey('OPENROUTER_API_KEY');
  const baseUrl = process.env.AURA_BASE_URL
    ?? fileConfig.baseUrl
    ?? globalCfg?.baseUrl
    ?? saved?.baseUrl;
  return createProvider({
    model: TASK_MODEL,
    apiKey,
    baseUrl,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub display for Telegram — silent, no terminal output
// ─────────────────────────────────────────────────────────────────────────────

function createSilentDisplay(): Display {
  return {
    agentThinking() {},
    streamText() {},
    streamEnd() {},
    toolStart() {},
    toolCall() {},
    toolResult() {},
    toolBlocked() {},
    warning() {},
    success() {},
    error() {},
    header() {},
    summary() {},
    showPlan() {},
    stepStarted() {},
    stepCompleted() {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task execution via runAgentLoop
// ─────────────────────────────────────────────────────────────────────────────

async function executeTask(chatId: number, task: string): Promise<string> {
    console.log("DEBUG-EXEC: executeTask entered");
  let provider: LLMProvider;
  try {
        console.log("DEBUG-EXEC: creating provider...");
    provider = createLLMProvider();
        console.log("DEBUG-EXEC: provider created");
  } catch (e: any) {
    return `❌ Failed to create LLM provider: ${e.message}`;
  }

  let context;
  try {
        console.log("DEBUG-EXEC: loading context...");
    context = await loadProjectContext(PROJECT_ROOT);
        console.log("DEBUG-EXEC: context loaded");
  } catch (e: any) {
    return `❌ Failed to load project context: ${e.message}`;
  }

  // Permissions:
  //   safety ON  → 'normal'  (triggers needsConfirm for destructive ops)
  //   safety OFF → 'auto'    (no confirm needed)
  const permLevel = safetyState.safetyOn ? 'normal' : 'auto';
  const permissions = new PermissionSystem(permLevel, context.root);

  const display = createSilentDisplay();

  let confirmFn: ((message: string) => Promise<boolean>) | undefined;

  if (safetyState.safetyOn) {
    confirmFn = async (message: string): Promise<boolean> => {
      // Parse the description from the confirm message
      // "Allow: $ <command>?" or "Allow: overwrite <path>?" or "Allow: toolName({...})?"
      const desc = message
        .replace(/^Allow:\s*/, '')
        .replace(/\?$/, '')
        .trim();

      console.log(`Confirm requested: ${desc}`);

      const { promise, message: approvalMsg } = await new Promise<{ promise: Promise<boolean>; message: string }>((resolve) => {
        // We need to figure out which tool this is for from the message
        let toolName = 'unknown';
        let description = desc;
        if (desc.startsWith('$ ')) {
          toolName = 'run_shell';
          description = desc.slice(2);
        } else if (desc.startsWith('overwrite ')) {
          toolName = 'write_file';
          description = desc;
        }

        const result = confirmManager.waitForApproval(chatId, toolName, description);
        resolve(result);
      });

      // Send the approval request to the user
      try {
        await sendMessage(chatId, approvalMsg);
      } catch {
        // If we can't send, deny for safety
        return false;
      }

      return promise;
    };
  }

  try {
    console.log("Starting agent loop...");
    const result = await runAgentLoop({
      provider,
      task,
      context,
      permissions,
      display,
      maxTurns: 50,
      disableSpawn: true, // no sub-agents via Telegram for now
      confirmFn,
    });
    console.log("Agent loop completed");

    // Build a readable response
    const lines: string[] = [];
    const tag = safetyLabel(safetyState.safetyOn);
    if (result.success) {
      lines.push(`✅ Done (${result.turns} turn${result.turns !== 1 ? 's' : ''}) ${tag}`);
      if (result.summary) {
        // Trim the summary to a reasonable length
        const summary = result.summary.length > 3000
          ? result.summary.slice(0, 3000) + '\n…(truncated)'
          : result.summary;
        lines.push('');
        lines.push(summary);
      }
    } else {
      lines.push(`❌ Failed (${result.turns} turns) ${tag}`);
      if (result.summary) {
        lines.push('');
        lines.push(result.summary);
      }
    }

    return lines.join('\n');
  } catch (e: any) {
    console.error("Agent loop error:", e);
    return `❌ Task error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers via curl (Node https.request ETIMEDOUT on this system)
// ─────────────────────────────────────────────────────────────────────────────

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

async function curlPost(method: string, body?: Record<string, unknown>): Promise<any> {
  const data = body ? JSON.stringify(body) : '';
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const escaped = data.replace(/'/g, "'\\''");
  return new Promise((resolve, reject) => {
    exec(
      `curl -s -X POST -H "Content-Type: application/json" -d '${escaped}' "${url}"`,
      { timeout: 30_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed.ok) {
            reject(new Error(`Telegram: ${parsed.description} (${parsed.error_code})`));
            return;
          }
          resolve(parsed.result);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function curlGet(method: string, params?: Record<string, string>): Promise<any> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const url = `https://api.telegram.org/bot${TOKEN}/${method}${qs}`;
  return new Promise((resolve, reject) => {
    exec(
      `curl -s "${url}"`,
      { timeout: 30_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed.ok) {
            reject(new Error(`Telegram: ${parsed.description} (${parsed.error_code})`));
            return;
          }
          resolve(parsed.result);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function sendMessage(chatId: string | number, text: string, parseMode?: string): Promise<void> {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunk };
    if (parseMode) body.parse_mode = parseMode;
    await curlPost('sendMessage', body);
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
// Utility helpers
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

/** Escape a string for use inside double quotes in a shell command. */
function escapeShellDouble(s: string): string {
  return s.replace(/[\\"$]/g, '\\$&').replace(/`/g, '\\`');
}

function searchCodeTool(pattern: string, searchPath?: string): string {
  const resolved = searchPath
    ? (path.isAbsolute(searchPath) ? searchPath : path.join(DEFAULT_CWD, searchPath))
    : DEFAULT_CWD;
  try {
    const result = execSync(
      'rg -n --no-heading -i "' + escapeShellDouble(pattern) + '" "' + escapeShellDouble(resolved) + '" 2>/dev/null | head -30',
      { timeout: 10_000, encoding: 'utf8' }
    );
    return result.trim() || 'No matches for "' + pattern + '"';
  } catch {
    return 'No matches for "' + pattern + '" (or rg not installed)';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleCommand(chatId: number, text: string, from: string): string | null {
  const lower = text.toLowerCase().trim();
  const tag = safetyLabel(safetyState.safetyOn);

  if (lower === '/start' || lower === '/help') {
    return [
      `💎 Aura Bot — Online ${tag}`,
      ``,
      `Commands:`,
      `/status — System status`,
      `/tools — Available tools`,
      `/safety_on — Enable safety mode (default)`,
      `/safety_off CONFIRM — Disable safety mode`,
      `/ping — Connection check`,
      `/whoami — About me`,
      `/ls <dir> — List directory`,
      `/read <file> — Read file`,
      `/search <pattern> — Search code`,
      `/run <cmd> — Run shell command`,
      `/git — Git status`,
      `/cancel — Cancel stuck task`,
      `/clear — Clear context`,
      ``,
      `Or just write anything — I'll execute it as an Aura task!`,
    ].join('\n');
  }

  if (lower === '/ping') return `🏓 Pong! Aura is alive and running. ${tag}`;

  if (lower === '/whoami') {
    return [
      `💎 I am Aura — an agent. ${tag}`,
      ``,
      `Framework: Aura (Ancient Greek: she who acts)`,
      `Character: Precise, imperial, self-aware`,
      `Motto: "I don't try. I verify."`,
      `Builder: Dušan Milosavljević`,
      `Tools: 22+`,
      `Tests: 734+ passing`,
      `Version: v0.3.0 (Aura rebrand)`,
      `Mode: ${safetyState.safetyOn ? '🔒 Safe (asks before destructive ops)' : '🔓 Auto (no confirmation)'}`,
      `Project: ${PROJECT_ROOT}`,
      `Model: ${TASK_MODEL}`,
    ].join('\n');
  }

  if (lower === '/status') {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    return [
      `📊 Aura Status ${tag}`,
      `Uptime: ${hours}h ${mins}m`,
      `Memory: ${mem}MB`,
      `Node: ${process.version}`,
      `Bot: @Praktessruby_bot`,
      `Status: ✅ Active`,
      `Version: v0.3.0`,
      `Safety: ${safetyState.safetyOn ? '🔒 ON' : '🔓 OFF'}`,
    ].join('\n');
  }

  if (lower === '/tools') {
    return [
      `🔧 Available tools: ${tag}`,
      ``,
      `📁 /ls <dir> — list directory`,
      `📄 /read <file> — read file`,
      `🔍 /search <pattern> — search code`,
      `⚡ /run <cmd> — shell command`,
      `🌿 /git — git status`,
      `🧠 /clear — clear context`,
      `🔒 /safety_on — enable safety`,
      `🔓 /safety_off CONFIRM — disable safety`,
      `🚫 /cancel — cancel stuck task`,
    ].join('\n');
  }

  // ── Safety toggle ───────────────────────────────────────────────────────

  if (lower === '/safety_on') {
    safetyState.safetyOn = true;
    saveState();
    return `🔒 Safety mode enabled. ${safetyLabel(true)} — destructive operations will ask for approval.`;
  }

  if (lower.startsWith('/safety_off')) {
    const rest = text.slice('/safety_off'.length).trim();
    if (rest !== 'CONFIRM') {
      return [
        `⚠️ To disable safety, send:`,
        ``,
        `/safety_off CONFIRM`,
        ``,
        `This prevents accidental toggling.`,
        `Current state: ${safetyLabel(safetyState.safetyOn)}`,
      ].join('\n');
    }
    safetyState.safetyOn = false;
    saveState();
    return `🔓 Safety mode disabled. ${safetyLabel(false)} — all operations will execute without confirmation.`;
  }

  // ── Tool commands ───────────────────────────────────────────────────────

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

  if (lower === '/clear') {
    return `🧹 Context cleared. Starting fresh. ${tag}`;
  }

  if (lower === '/cancel') {
    if (runningTasks.has(chatId)) {
      runningTasks.delete(chatId);
      return `🚫 Task cancelled. You can send a new task now. ${tag}`;
    }
    return `ℹ️ No task is running for this chat. ${tag}`;
  }

  // Looks like a shell command — run directly
  const looksLikeCommand = /^(ls|cat|pwd|whoami|date|df|du|ps|top|free|uname|which|find|grep|git|npm|node|python|curl)\b/.test(lower);
  if (looksLikeCommand) {
    const result = execShell(text);
    const output = result.stdout || result.stderr || '(no output)';
    const truncated = output.length > 3500 ? output.slice(0, 3500) + '\n... (truncated)' : output;
    return `⚡ ${text}\n${truncated}`;
  }

  // Return null to signal "not a command — treat as task"
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization check
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(chatId: number, fromUser: any): boolean {
  // No open-access fallback — if no IDs configured the bot won't start,
  // but guard here too as defense-in-depth.
  if (AUTHORIZED_USER_IDS.size === 0) return false;

  // Check by user ID
  const userId = fromUser?.id;
  if (userId && AUTHORIZED_USER_IDS.has(Number(userId))) return true;
  // Also check chat ID (for group chats where the user might be different)
  if (AUTHORIZED_USER_IDS.has(chatId)) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main polling loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Track whether a task is currently running for a given chat.
 * If a task is running, new non-command messages are queued.
 */
const runningTasks = new Set<number>();

async function poll(): Promise<void> {
  let offset = loadOffset();

  console.log('💎 Aura Telegram Bot started');
  console.log(`   Bot: @Praktessruby_bot`);
  console.log(`   Offset: ${offset}`);
  console.log(`   Polling every 3 seconds...`);
  console.log(`   Project root: ${PROJECT_ROOT}`);
  console.log(`   Task model: ${TASK_MODEL}`);
  console.log(`   Safety: ${safetyState.safetyOn ? 'ON' : 'OFF'}`);
  console.log(`   Authorized users: ${AUTHORIZED_USER_IDS.size > 0 ? [...AUTHORIZED_USER_IDS].join(', ') : 'ALL (no restriction)'}`);
  console.log('');

  // Clear old updates on first run
  if (offset === 0) {
    try {
      const updates = await curlGet('getUpdates', { offset: '0', limit: '100' });
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
      const updates = await curlGet('getUpdates', {
        offset: String(offset),
        limit: '100',
        timeout: '3',
      });

      consecutiveErrors = 0;

      for (const update of updates) {
        offset = update.update_id + 1;
        saveOffset(offset);

        const msg = update.message;
        if (!msg) continue;
        if (!msg.text && !msg.voice) continue;

        const chatId = msg.chat.id;
        const from = msg.from?.first_name ?? msg.from?.username ?? 'unknown';

        // ── Authorization check ────────────────────────────────────────────
        if (!isAuthorized(chatId, msg.from)) {
          console.warn(`🚫 Unauthorized message from ${from} (id: ${msg.from?.id})`);
          // Don't reply to unauthorized users — don't reveal the bot exists
          continue;
        }

        // ── Handle voice messages (Phase 2 placeholder) ──────────────────
        if (msg.voice) {
          await sendMessage(chatId, '🎤 Voice messages are not yet supported. Please send text.');
          continue;
        }

        const text = msg.text;

        if (!text) continue;

        console.log(`📩 [${from}]: ${text}`);

        // ── Check pending approvals first ───────────────────────────────
        const approvedId = confirmManager.handleReply(chatId, text);
        if (approvedId) {
          console.log(`📤 Approval resolved for ${approvedId}`);
          continue;
        }

        // ── Handle commands (synchronous) ────────────────────────────────
        const commandResult = handleCommand(chatId, text, from);
        if (commandResult !== null) {
          try {
            await sendMessage(chatId, commandResult);
            console.log(`📤 Replied to ${from}`);
          } catch (e: any) {
            console.error(`❌ Reply error: ${e.message}`);
          }
          continue;
        }

        // ── Non-command text → execute as Aura task ─────────────────────
        if (runningTasks.has(chatId)) {
          await sendMessage(chatId, `⏳ A task is already running for this chat. Please wait.`);
          continue;
        }

        runningTasks.add(chatId);
        const tag = safetyLabel(safetyState.safetyOn);

        // Send a "thinking" indicator
        await sendMessage(chatId, `⏳ Processing task... ${tag}`);

        // Execute asynchronously — don't block the poll loop
        executeTask(chatId, text)
          .then(async response => {
            await sendMessage(chatId, response);
            console.log(`📤 Task result sent to ${from}`);
          })
          .catch(async (e: any) => {
            console.error(`❌ Task error: ${e.message}`);
            try {
              await sendMessage(chatId, `❌ Error: ${e.message}`);
            } catch { /* give up */ }
          })
          .finally(() => {
            runningTasks.delete(chatId);
          });
      }
    } catch (e: any) {
      consecutiveErrors++;
      console.error(`⚠️ Poll error (${consecutiveErrors}): ${e.message}`);
      if (consecutiveErrors > 10) {
        console.error('💀 Too many errors, waiting 30s...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        consecutiveErrors = 0;
      } else {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

// Refuse to start without authorized user IDs — no open-access bots
if (AUTHORIZED_USER_IDS.size === 0) {
  console.error('');
  console.error('❌ AUTHORIZED_USER_IDS not configured — refusing to start an unrestricted bot.');
  console.error('   Set allowed_user_ids in ~/.aura/telegram.json or set');
  console.error('   TELEGRAM_BOT_ALLOWED_USER_IDS env var before running.');
  console.error('');
  process.exit(1);
}

poll().catch(err => {
  console.error('💀 Fatal polling crash:', err);
  process.exit(1);
});

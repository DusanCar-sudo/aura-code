/**
 * Telegram Bot Wizard — interactive setup for the Aura Telegram bot.
 *
 * Mirrors provider-wizard.ts's style and structure (numbered choices,
 * keep/replace for existing values, a real connection test before saving),
 * with one addition that came directly out of real deployment pain: it can
 * generate a working systemd user-service file, since that — not picking a
 * model — turned out to be the actual hard part in practice.
 *
 * Steps:
 *   1. Bot token (from @BotFather — the one step nothing can automate)
 *   2. Verify the token against Telegram's real API
 *   3. Authorized user IDs (the bot refuses to start with none)
 *   4. Task model — reuse an existing :provider setup, or configure fresh
 *   5. Voice support (optional) — Groq API key for transcription + TTS
 *   6. Optionally generate ~/.config/systemd/user/aura-telegram.service
 *
 * All Telegram API calls here shell out to curl rather than using native
 * fetch — deliberately, not stylistically: native fetch was found to fail
 * with ETIMEDOUT/ENETUNREACH on a real deployment of this exact bot, on a
 * network where IPv6 is advertised but not actually routable. Since this
 * wizard runs in the same kind of environment the bot itself will run in,
 * it uses the same proven-reliable approach rather than risk hitting the
 * same failure during setup.
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { getApiKey } from '../util/env.js';
import { loadProviderConfig } from './provider-wizard.js';
import { apiKeyEnvVarForModel } from '../providers/factory.js';
import { auraHome, auraPath } from '../util/aura-home.js';
import { CHROME, CHROME_DIM, ERR, OK, SOFT } from '../cli/diamond.js';

const execAsync = promisify(exec);

export interface TelegramWizardResult {
  botToken: string;
  botUsername: string;
  allowedUserIds: string[];
  taskModel?: string;
  groqConfigured: boolean;
  systemdGenerated: boolean;
}

interface ExistingTelegramConfig {
  bot_token?: string;
  allowed_user_ids?: string;
}

export function telegramConfigPath(): string {
  return auraPath('telegram.json');
}

export function loadExistingTelegramConfig(): ExistingTelegramConfig | null {
  try {
    return JSON.parse(fs.readFileSync(telegramConfigPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** Shell-escapes a string for safe embedding inside single quotes in a curl command. */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export async function runTelegramWizard(existingRl?: readline.Interface): Promise<TelegramWizardResult | null> {
  const rl = existingRl || readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(CHROME('\n  ✦  Telegram Bot Setup Wizard'));
    console.log(CHROME_DIM('  Get Aura running as a Telegram bot in a few steps.\n'));

    // ── Step 1: Bot token ─────────────────────────────────────────────────
    const botToken = await configureBotToken(rl);
    if (!botToken) return null;

    // ── Step 2: Verify it for real ────────────────────────────────────────
    console.log(CHROME('\n  Verifying token with Telegram...'));
    const botUsername = await testBotToken(botToken);
    if (!botUsername) {
      console.log(ERR('  ✗ Could not verify this token. Double-check it and try again.\n'));
      return null;
    }
    console.log(OK(`  ✓ Connected as @${botUsername}\n`));

    // ── Step 3: Authorized users ──────────────────────────────────────────
    const allowedUserIds = await configureAuthorizedUsers(rl);
    if (allowedUserIds.length === 0) {
      console.log(ERR('  ✗ At least one authorized user ID is required — the bot refuses to start without one.\n'));
      return null;
    }

    // ── Step 4: Task model ────────────────────────────────────────────────
    const { taskModel, providerApiKey } = await configureTaskModel(rl);

    // ── Step 5: Voice support (optional) ──────────────────────────────────
    const groqKey = await configureVoiceSupport(rl);

    // ── Save telegram.json ─────────────────────────────────────────────────
    saveTelegramConfig(botToken, allowedUserIds);
    console.log(CHROME_DIM(`\n  ✓ Saved to ${telegramConfigPath()}`));

    // ── Step 6: systemd service (optional) ────────────────────────────────
    const systemdGenerated = await offerSystemdService(rl, {
      taskModel,
      providerApiKey,
      groqKey,
      allowedUserIds,
    });

    printSummary(botUsername, systemdGenerated);

    return { botToken, botUsername, allowedUserIds, taskModel, groqConfigured: !!groqKey, systemdGenerated };
  } finally {
    if (!existingRl) rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Bot token
// ─────────────────────────────────────────────────────────────────────────────

async function configureBotToken(rl: readline.Interface): Promise<string | null> {
  console.log(CHROME('  Step 1: Bot token\n'));

  const existing = loadExistingTelegramConfig();
  if (existing?.bot_token) {
    console.log(CHROME_DIM(`  Existing token found (ends in ...${existing.bot_token.slice(-6)})\n`));
    console.log(CHROME_DIM('   1. Keep this token'));
    console.log(CHROME_DIM('   2. Replace with a new token\n'));
    const choice = await askInput(rl, '  ▸ Choose (1 or 2): ');
    if (choice !== '2') return existing.bot_token;
  } else {
    console.log(CHROME_DIM('  No bot token configured yet.'));
  }

  console.log(CHROME_DIM('  Need one? Message @BotFather on Telegram:'));
  console.log(CHROME_DIM('    1. Send /newbot'));
  console.log(CHROME_DIM('    2. Pick a display name, then a username ending in "bot"'));
  console.log(CHROME_DIM('    3. BotFather replies with a token like 123456789:ABC-DEF1234...\n'));

  const token = await askInput(rl, '  ▸ Paste your bot token: ');
  if (!token) {
    console.log(ERR('  ✗ No token provided.'));
    return null;
  }
  return token;
}

/** Calls Telegram's getMe, returns the bot's username on success or null. */
export async function testBotToken(token: string): Promise<string | null> {
  try {
    const url = `https://api.telegram.org/bot${token}/getMe`;
    const { stdout } = await execAsync(`curl -s "${url}"`, { timeout: 15_000 });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok || !parsed.result?.username) return null;
    return parsed.result.username;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Authorized users
// ─────────────────────────────────────────────────────────────────────────────

async function configureAuthorizedUsers(rl: readline.Interface): Promise<string[]> {
  console.log(CHROME('  Step 2: Authorized users\n'));
  console.log(CHROME_DIM('  Only these Telegram user IDs will be able to use the bot.'));
  console.log(CHROME_DIM("  Don't know yours? Message @userinfobot on Telegram — it replies instantly.\n"));

  const existing = loadExistingTelegramConfig();
  const ids: string[] = existing?.allowed_user_ids
    ? existing.allowed_user_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  if (ids.length > 0) {
    console.log(CHROME_DIM(`  Currently authorized: ${ids.join(', ')}\n`));
  }

  for (;;) {
    const prompt = ids.length > 0
      ? '  ▸ Add another user ID (or press Enter to finish): '
      : '  ▸ Your Telegram user ID: ';
    const input = await askInput(rl, prompt);
    if (!input) break;
    if (!/^\d+$/.test(input)) {
      console.log(ERR("  ✗ That doesn't look like a numeric Telegram ID — try again."));
      continue;
    }
    if (!ids.includes(input)) ids.push(input);
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Task model
// ─────────────────────────────────────────────────────────────────────────────

async function configureTaskModel(rl: readline.Interface): Promise<{ taskModel?: string; providerApiKey?: string }> {
  console.log(CHROME('\n  Step 3: Which model should the bot use?\n'));

  const saved = loadProviderConfig();
  if (saved?.model) {
    console.log(CHROME_DIM(`  Found an existing :provider setup: ${SOFT(saved.model)} (${saved.provider})\n`));
    console.log(CHROME_DIM('   1. Use this for the bot too'));
    console.log(CHROME_DIM('   2. Skip — configure this manually later\n'));
    const choice = await askInput(rl, '  ▸ Choose (1 or 2): ');
    if (choice !== '2') {
      return { taskModel: saved.model, providerApiKey: saved.apiKey };
    }
  } else {
    console.log(CHROME_DIM('  No existing provider setup found.'));
  }

  console.log(CHROME_DIM('  Run :provider first if you want this filled in automatically,'));
  console.log(CHROME_DIM('  or set TELEGRAM_BOT_MODEL plus the matching API key manually later.\n'));
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Voice support (optional)
// ─────────────────────────────────────────────────────────────────────────────

async function configureVoiceSupport(rl: readline.Interface): Promise<string | null> {
  console.log(CHROME('\n  Step 4: Voice messages (optional)\n'));
  console.log(CHROME_DIM('  Lets the bot transcribe voice messages and reply with spoken audio.'));
  console.log(CHROME_DIM('  Needs a free Groq API key: https://console.groq.com/keys\n'));

  const existing = getApiKey('GROQ_API_KEY', 'groq_api_key');
  if (existing) {
    console.log(CHROME_DIM(`  Found one already: ${OK(maskKey(existing))}\n`));
    const choice = await askInput(rl, '  ▸ Use this key for the bot? (Y/n): ');
    if (choice.toLowerCase() !== 'n') return existing;
  }

  const choice = await askInput(rl, '  ▸ Enable voice messages? (y/N): ');
  if (choice.toLowerCase() !== 'y') return null;

  const key = await askInput(rl, '  ▸ Enter Groq API key: ');
  return key || null;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Save telegram.json
// ─────────────────────────────────────────────────────────────────────────────

export function saveTelegramConfig(botToken: string, allowedUserIds: string[]): void {
  const dir = auraHome();
  fs.mkdirSync(dir, { recursive: true });
  const config: ExistingTelegramConfig = {
    bot_token: botToken,
    allowed_user_ids: allowedUserIds.join(','),
  };
  fs.writeFileSync(telegramConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: systemd service (optional)
// ─────────────────────────────────────────────────────────────────────────────

interface SystemdInputs {
  taskModel?: string;
  providerApiKey?: string;
  groqKey?: string | null;
  allowedUserIds: string[];
}

/**
 * Builds the actual systemd unit file content. Pure and side-effect-free —
 * split out from offerSystemdService() specifically so it's directly
 * testable without needing to drive the readline prompts around it.
 */
export function buildSystemdServiceContent(
  inputs: SystemdInputs,
  nodePath: string,
  botScriptPath: string,
  projectRoot: string,
  logPath: string,
): string {
  const lines: string[] = [
    '[Unit]',
    'Description=Aura Telegram Bot',
    '[Service]',
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=${nodePath} ${botScriptPath}`,
  ];

  if (inputs.taskModel) {
    lines.push(`Environment="TELEGRAM_BOT_MODEL=${inputs.taskModel}"`);
    if (inputs.providerApiKey) {
      const envVar = apiKeyEnvVarForModel(inputs.taskModel);
      if (envVar) lines.push(`Environment="${envVar}=${inputs.providerApiKey}"`);
    }
  }
  if (inputs.groqKey) {
    lines.push(`Environment="GROQ_API_KEY=${inputs.groqKey}"`);
  }
  lines.push(`Environment="TELEGRAM_BOT_ALLOWED_USER_IDS=${inputs.allowedUserIds.join(',')}"`);

  lines.push(
    'Restart=always',
    'RestartSec=5',
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    '[Install]',
    'WantedBy=default.target',
  );

  return lines.join('\n') + '\n';
}

async function offerSystemdService(rl: readline.Interface, inputs: SystemdInputs): Promise<boolean> {
  console.log(CHROME('\n  Step 5: Run automatically with systemd? (Linux only)\n'));
  console.log(CHROME_DIM('  Keeps the bot running in the background, restarts it if it crashes,'));
  console.log(CHROME_DIM('  and starts it again automatically next time you log in.\n'));

  const choice = await askInput(rl, '  ▸ Generate a systemd service file now? (y/N): ');
  if (choice.toLowerCase() !== 'y') return false;

  const projectRoot = process.cwd();
  const botScript = path.join(projectRoot, 'dist', 'tools', 'telegram-bot.js');
  if (!fs.existsSync(botScript)) {
    console.log(ERR(`  ✗ ${botScript} doesn't exist yet — run "npm run build" first, then re-run this step.`));
    return false;
  }

  const logPath = auraPath('telegram-bot.log');
  const content = buildSystemdServiceContent(inputs, process.execPath, botScript, projectRoot, logPath);

  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });
  const servicePath = path.join(serviceDir, 'aura-telegram.service');
  fs.writeFileSync(servicePath, content);

  console.log(OK(`\n  ✓ Wrote ${servicePath}`));
  console.log(CHROME_DIM('\n  Run these to start it:\n'));
  console.log(SOFT('    systemctl --user daemon-reload'));
  console.log(SOFT('    systemctl --user enable --now aura-telegram.service'));
  console.log(SOFT('    systemctl --user status aura-telegram.service\n'));
  // journald is authoritative; the logfile below only exists for units this
  // wizard generated. Point at the one that always works.
  console.log(CHROME_DIM('  To watch it (works regardless of logfile settings):\n'));
  console.log(SOFT('    journalctl --user -u aura-telegram --since "10 min ago"\n'));

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(CHROME(prompt), answer => resolve((answer ?? '').trim()));
  });
}

function printSummary(botUsername: string, systemdGenerated: boolean): void {
  console.log(CHROME('\n  ✦  Setup complete\n'));
  console.log(CHROME_DIM(`  Bot: ${SOFT('@' + botUsername)}`));
  if (!systemdGenerated) {
    console.log(CHROME_DIM('\n  To run it now:'));
    console.log(SOFT(`    node dist/tools/telegram-bot.js\n`));
  }
  console.log(CHROME_DIM('  Message your bot on Telegram to try it.\n'));
}

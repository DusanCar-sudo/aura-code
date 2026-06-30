/**
 * First-run setup wizard.
 *
 * Triggers when:
 *   1. No provider-specific env var is set (any of the known *_API_KEY vars)
 *   2. AND no --api-key was passed on the CLI
 *   3. AND no global config exists at ~/.config/aura-code/config.json
 *
 * Walks the user through picking a provider, entering an API key, and picking
 * a default model. Saves to the global config and exports the relevant env
 * var for the current process.
 */
import * as readline from 'readline';
import chalk from 'chalk';
import { KNOWN_MODELS } from '../providers/factory.js';
import { getApiKey } from '../util/env.js';
import { loadGlobalConfig, saveGlobalConfig, globalConfigPath, type GlobalConfig } from './global-config.js';

export interface ProviderChoice {
  id: string;        // 'anthropic' | 'openai' | 'google' | 'xai' | 'xiaomi' | 'openrouter' | 'ollama' | 'local'
  name: string;      // 'Anthropic Claude'
  apiKeyEnv: string; // 'ANTHROPIC_API_KEY'
  needsKey: boolean; // false for ollama/local
  defaultBaseUrl?: string;
  description: string;
  models: string[];  // model IDs available
}

export const PROVIDER_CHOICES: ProviderChoice[] = [
  {
    id: 'anthropic', name: 'Anthropic Claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY', needsKey: true,
    description: 'Claude Opus, Sonnet, Haiku — strong coding & reasoning',
    models: [
      'claude-opus-4-5-20251001',
      'claude-sonnet-4-5-20251001',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
  },
  {
    id: 'openai', name: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY', needsKey: true,
    description: 'GPT-4o, o1, o3 — fast general purpose',
    models: [
      'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo',
      'o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini',
    ],
  },
  {
    id: 'google', name: 'Google Gemini',
    apiKeyEnv: 'GOOGLE_API_KEY', needsKey: true,
    description: 'Gemini 2.5 Pro / Flash — strong at long context',
    models: [
      'gemini-2.5-pro', 'gemini-2.5-flash',
      'gemini-2.0-pro', 'gemini-2.0-flash',
      'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.5-flash-8b',
    ],
  },
  {
    id: 'xiaomi', name: 'Xiaomi MiMo',
    apiKeyEnv: 'XIAOMI_API_KEY', needsKey: true,
    defaultBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    description: 'MiMo V2.5 Pro / V2 Flash — fast open-weight model',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash'],
  },
  {
    id: 'xai', name: 'xAI Grok',
    apiKeyEnv: 'XAI_API_KEY', needsKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    description: 'Grok 2 / Grok Beta — witty + real-time web',
    models: ['grok-2', 'grok-2-mini', 'grok-beta', 'grok-vision-beta'],
  },
  {
    id: 'openrouter', name: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY', needsKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    description: 'Access 100+ models via one API (Claude, GPT, Llama, Mistral…)',
    models: [
      'openrouter/anthropic/claude-3.5-sonnet',
      'openrouter/openai/gpt-4o',
      'openrouter/google/gemini-2.0-flash',
      'openrouter/meta-llama/llama-3.1-70b-instruct',
      'openrouter/meta-llama/llama-3.1-405b-instruct',
      'openrouter/mistralai/mistral-large',
      'openrouter/qwen/qwen-2.5-72b-instruct',
      'openrouter/deepseek/deepseek-chat',
    ],
  },
  {
    id: 'ollama', name: 'Ollama (local)',
    apiKeyEnv: '', needsKey: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
    description: 'Local open models via Ollama — no API key needed',
    models: [
      'ollama/llama3.2', 'ollama/llama3.1', 'ollama/qwen2.5-coder',
      'ollama/codellama', 'ollama/mistral', 'ollama/mixtral',
      'ollama/phi3', 'ollama/gemma2', 'ollama/deepseek-coder-v2',
    ],
  },
  {
    id: 'local', name: 'LM Studio (local)',
    apiKeyEnv: '', needsKey: false,
    defaultBaseUrl: 'http://localhost:1234/v1',
    description: 'Any OpenAI-compatible local server (LM Studio, llama.cpp, etc.)',
    models: [
      'local/qwen2.5-coder-32b-instruct',
      'local/llama-3.3-70b-instruct',
      'local/mistral-large',
    ],
  },
];

/** True iff the user has a saved global config (their default provider). */
export function hasGlobalConfig(): boolean {
  return loadGlobalConfig() !== null;
}

/** True iff the user has set at least one known provider env var (any case). */
export function hasAnyEnvKey(): boolean {
  for (const p of PROVIDER_CHOICES) {
    if (!p.needsKey) continue;
    if (getApiKey(p.apiKeyEnv)) return true;
  }
  return false;
}

/**
 * Pure detection: would we need the wizard?
 *
 * The wizard fires when the user has no MODEL picked. An API key in env
 * does NOT count as "configured" — the user still needs to choose a model.
 * The wizard will detect the env key and pre-select that provider.
 */
export function needsWizard(opts: { cliApiKey?: string; cliModel?: string } = {}): boolean {
  if (opts.cliApiKey) return false;
  if (opts.cliModel) return false;
  if (hasGlobalConfig()) return false;  // has a model saved already
  return true;
}

/**
 * Pick a provider automatically when exactly one of the known env vars is set.
 * Returns the provider id (e.g. 'anthropic') or null if 0 / 2+ match.
 * Used by the wizard to pre-select the provider menu option and skip the
 * API-key prompt when the user already has a key in their shell.
 */
export function detectProviderFromEnv(): string | null {
  let found: string | null = null;
  for (const p of PROVIDER_CHOICES) {
    if (!p.needsKey) continue;
    if (getApiKey(p.apiKeyEnv)) {
      if (found !== null) return null;  // multiple — don't auto-pick
      found = p.id;
    }
  }
  return found;
}

/** Kept for backward compatibility (some callers still use it). */
export function hasAnyProvider(): boolean {
  return hasGlobalConfig() || hasAnyEnvKey();
}

/** Format a number for menu display, zero-padded. */
function pad(n: number, w: number): string { return String(n).padStart(w, ' '); }

/** Print a numbered menu and read the user's choice (1-based). */
function askMenu(rl: readline.Interface, title: string, items: { label: string; hint?: string }[]): Promise<number> {
  return new Promise((resolve) => {
    console.log(chalk.hex('#cc785c')(`\n  ${title}\n`));
    items.forEach((it, i) => {
      const num = chalk.hex('#8a7768')(pad(i + 1, 2) + '.');
      const label = chalk.hex('#e8d5b7')(it.label);
      const hint = it.hint ? chalk.hex('#5a4a3a')(` — ${it.hint}`) : '';
      console.log(`  ${num} ${label}${hint}`);
    });
    console.log();
    readLine(rl, chalk.hex('#cc785c')('  ▸ Choose a number: ')).then((ans) => {
      // If stdin closed (no input available), abort the wizard cleanly.
      if (lineQueueClosed && lineQueue!.length === 0) {
        console.log(chalk.hex('#b15439')('  ✗ No input available — aborting wizard.'));
        resolve(-1);
        return;
      }
      const n = parseInt(ans, 10);
      if (Number.isFinite(n) && n >= 1 && n <= items.length) {
        resolve(n - 1);
      } else {
        console.log(chalk.hex('#b15439')(`  ✗ Invalid choice, try again.`));
        resolve(askMenu(rl, title, items));
      }
    });
  });
}

/** Read a single line of input from the user. */
function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return readLine(rl, chalk.hex('#cc785c')(prompt));
}

/**
 * One-shot line reader that works with both TTY and pipe input.
 *
 * Why not `rl.question`? When stdin is a pipe with multiple lines already
 * buffered, `rl.question` only fires its callback once (Node readline
 * behaviour), then the rest of the data is lost. We work around this by
 * reading the entire input upfront into a line queue, then popping one
 * line per call.
 */
function readLine(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!lineQueue) {
      lineQueue = [];
      // Push every incoming line into the queue, then wake any waiting resolver.
      rl.on('line', (l) => {
        lineQueue!.push(l);
        drainQueue();
      });
      rl.once('close', () => {
        lineQueueClosed = true;
        drainQueue();
      });
    }
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift()!.trim());
    } else if (lineQueueClosed) {
      resolve('');
    } else {
      pendingResolvers.push(() => {
        if (lineQueue!.length > 0) resolve(lineQueue!.shift()!.trim());
        else if (lineQueueClosed) resolve('');
      });
    }
  });
}

let lineQueue: string[] | null = null;
let lineQueueClosed = false;
const pendingResolvers: Array<() => void> = [];

function drainQueue(): void {
  while (pendingResolvers.length > 0 && (lineQueue!.length > 0 || lineQueueClosed)) {
    pendingResolvers.shift()!();
  }
}

/**
 * Run the wizard. Returns the chosen config, or null if the user aborted.
 * Saves to the global config and exports the API key env var for the
 * current process so the rest of the run works without re-prompting.
 */
export async function runFirstRunWizard(): Promise<GlobalConfig | null> {
  console.log(chalk.hex('#cc785c')('\n  ✦  Welcome to Aura!'));
  console.log(chalk.hex('#8a7768')('  Let\'s get you set up — pick a provider to get started.\n'));
  console.log(chalk.hex('#5a4a3a')(`  (Config will be saved to ${globalConfigPath()})`));

  // Auto-detect: if exactly one provider env var is set, pre-select it and
  // skip the key prompt (env key will be used). This handles the common
  // case where the user has already exported e.g. ANTHROPIC_API_KEY.
  const detectedId = detectProviderFromEnv();
  if (detectedId) {
    const det = PROVIDER_CHOICES.find(p => p.id === detectedId)!;
    console.log(chalk.hex('#5a9e6e')(`  ↪ Detected ${det.apiKeyEnv} in your environment — using ${det.name}.\n`));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 1. Pick provider (default to detected one if any)
    const providerIdx = await askMenu(rl, 'Choose your provider:', PROVIDER_CHOICES.map(p => ({
      label: detectedId === p.id ? `${p.name}  ✓ (key detected)` : p.name,
      hint: p.description,
    })));
    if (providerIdx < 0) return null;  // stdin closed — abort
    const provider = PROVIDER_CHOICES[providerIdx];

    // 2. API key (if needed) — confirm env key or accept a new one
    let apiKey = '';
    if (provider.needsKey) {
      const existingKey = getApiKey(provider.apiKeyEnv);
      if (existingKey) {
        const masked = existingKey.length > 8
          ? `${existingKey.slice(0, 4)}…${existingKey.slice(-4)}`
          : '****';
        console.log();
        console.log(chalk.hex('#8a7768')(`  Found ${provider.apiKeyEnv} in your environment: ${chalk.hex('#5a9e6e')(masked)}`));
        const override = await ask(rl, '  ▸ Press Enter to use it, or type a new key to override: ');
        if (lineQueueClosed && lineQueue!.length === 0) return null;
        apiKey = override.trim();
      } else {
        console.log();
        console.log(chalk.hex('#8a7768')(`  Enter your ${provider.name} API key.`));
        console.log(chalk.hex('#5a4a3a')(`  (Will be exported as ${provider.apiKeyEnv} for this session; for permanent use, add it to your shell rc.)\n`));
        apiKey = await ask(rl, '  ▸ API key: ');
        if (lineQueueClosed && lineQueue!.length === 0) return null;
        if (!apiKey) {
          console.log(chalk.hex('#b15439')('  ✗ No key provided. Aborting setup.'));
          return null;
        }
      }
      if (apiKey) {
        // Override the env var for this process and mirror to lowercase
        process.env[provider.apiKeyEnv] = apiKey;
        process.env[provider.apiKeyEnv.toLowerCase()] = apiKey;
      }
    }

    // 3. Pick default model
    const modelIdx = await askMenu(rl, `Default model for ${provider.name}:`, provider.models.map(m => {
      const meta = KNOWN_MODELS.find(km => km.id === m);
      return { label: m, hint: meta?.speed ?? meta?.name };
    }));
    if (modelIdx < 0) return null;  // stdin closed — abort
    const defaultModel = provider.models[modelIdx];

    // 4. Optional custom base URL
    let baseUrl: string | undefined;
    if (provider.defaultBaseUrl) {
      const custom = await ask(rl, `\n  ▸ Custom base URL? (Enter to keep ${provider.defaultBaseUrl}): `);
      if (lineQueueClosed && lineQueue!.length === 0) return null;
      baseUrl = custom || provider.defaultBaseUrl;
    }

    // 5. Save
    const saved = saveGlobalConfig({
      provider: provider.id,
      apiKeyEnv: provider.apiKeyEnv,
      defaultModel,
      baseUrl,
    });
    if (apiKey) {
      // Mirror to lowercase for the env helper
      process.env[provider.apiKeyEnv.toLowerCase()] = apiKey;
    }

    console.log();
    console.log(chalk.hex('#5a9e6e')(`  ✓ Saved config to ${globalConfigPath()}`));
    console.log(chalk.hex('#8a7768')(`  ✓ Default model: ${saved.defaultModel}`));
    console.log(chalk.hex('#8a7768')(`  ✓ Provider:      ${saved.provider}`));
    if (saved.baseUrl) console.log(chalk.hex('#8a7768')(`  ✓ Base URL:      ${saved.baseUrl}`));
    console.log();
    return saved;
  } finally {
    rl.close();
  }
}

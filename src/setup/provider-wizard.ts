/**
 * Provider Wizard — interactive 4-step flow to configure LLM provider,
 * model, API key, and test the connection.
 *
 * Steps:
 *   1. Select provider
 *   2. Select model (or auto-detect for Ollama)
 *   3. API key (detect existing, keep/replace, or enter new)
 *   4. Test connection and save to config
 *
 * Saves config to ~/.config/aura-code/config.json (via global-config).
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import chalk from 'chalk';
import {
  PROVIDER_REGISTRY, detectExistingKey, maskApiKey,
  type ProviderEntry,
} from './provider-registry.js';
import { testProviderConnection, normalizeBaseUrl, type TestFailureKind } from './provider-test.js';
import { saveGlobalConfig, globalConfigPath } from './global-config.js';
import { saveKey } from './key-store.js';
import { defaultXiaomiBaseUrl, normalizeXiaomiWizardConfig, xiaomiKeyKind } from './xiaomi.js';
import { ZHIPU_CODING_BASE_URL, ZHIPU_GENERAL_BASE_URL } from '../providers/factory.js';

export interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * Run the full 4-step provider wizard.
 *
 * Returns the chosen config on success, or null if the user cancelled.
 *
 * @param existingRl - Optional readline interface (for non-TUI mode)
 * @param askInputFn - Optional askInput function (for TUI mode)
 */
export async function runProviderWizard(existingRl?: readline.Interface, askInputFn?: (prompt: string) => Promise<string>): Promise<ProviderConfig | null> {
  const rl = existingRl || readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(chalk.hex('#cc785c')('\n  ✦  Provider Setup Wizard'));
    console.log(chalk.hex('#8a7768')('  Configure your AI provider in 3 easy steps.\n'));

    // ── Step 1: Select Provider ─────────────────────────────────────────────
    const provider = await selectProvider(rl, askInputFn);
    if (!provider) return null;

    // ── Step 2: Select Model ────────────────────────────────────────────────
    const model = await selectModel(rl, provider, askInputFn);
    if (!model) return null;

    // ── Step 3: API Key ─────────────────────────────────────────────────────
    const apiKey = await configureApiKey(rl, provider, askInputFn);
    if (apiKey === null && provider.envKey !== null) return null; // Cancelled (needed key but got null)

    let effectiveModel = model;

    if (provider.name === 'GLM (Zhipu)') {
      console.log(chalk.hex('#cc785c')('\n  Which GLM plan are you using?\n'));
      console.log(`  ${chalk.hex('#8a7768')('1.')} ${chalk.hex('#e8d5b7')('Coding Plan')} ${chalk.hex('#5a4a3a')('(subscription quota)')}`);
      console.log(`  ${chalk.hex('#8a7768')('2.')} ${chalk.hex('#e8d5b7')('Pay-as-you-go')} ${chalk.hex('#5a4a3a')('(general API key)')}`);
      const planChoice = await askInput(rl, '  ▸ Choose (1 or 2): ', askInputFn);
      if (planChoice.trim() === '1') {
        effectiveModel = `zhipu-coding/${model}`;
      }
    }

    // Xiaomi Token Plan is region-scoped; pay-as-you-go (sk-) keys all use
    // the same host, so only ask when the region actually matters.
    let xiaomiRegion: 'sgp' | 'cn' | 'ams' = 'sgp';
    if (provider.name === 'Xiaomi MiMo' && xiaomiKeyKind(apiKey ?? undefined) !== 'paygo') {
      console.log(chalk.hex('#cc785c')('\n  Which Token Plan region?\n'));
      console.log(`  ${chalk.hex('#8a7768')('1.')} ${chalk.hex('#e8d5b7')('Singapore')} ${chalk.hex('#5a4a3a')('(default)')}`);
      console.log(`  ${chalk.hex('#8a7768')('2.')} ${chalk.hex('#e8d5b7')('China')}`);
      console.log(`  ${chalk.hex('#8a7768')('3.')} ${chalk.hex('#e8d5b7')('Amsterdam')}`);
      const regionChoice = (await askInput(rl, '  ▸ Choose (1, 2, or 3) [1]: ', askInputFn)).trim();
      if (regionChoice === '2') xiaomiRegion = 'cn';
      else if (regionChoice === '3') xiaomiRegion = 'ams';
    }

    // Build baseUrl
    let baseUrlPrompt = '  ▸ Enter base URL: ';
    const defaultBase = provider.name === 'Xiaomi MiMo'
      ? defaultXiaomiBaseUrl(apiKey ?? undefined, xiaomiRegion)
      : provider.name === 'GLM (Zhipu)'
        ? (effectiveModel.startsWith('zhipu-coding/') ? ZHIPU_CODING_BASE_URL : ZHIPU_GENERAL_BASE_URL)
        : (provider.baseUrl || '');
    if (defaultBase) {
      baseUrlPrompt = `  ▸ Enter base URL [press Enter to use default ${chalk.hex('#ede0cc')(defaultBase)}]: `;
    }
    const enteredUrl = await askInput(rl, baseUrlPrompt, askInputFn);
    let baseUrl = enteredUrl.trim() || defaultBase || provider.baseUrl || '';
    // Normalize user-typed URLs (trailing slash, pasted /chat/completions path).
    if (baseUrl) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (normalized !== baseUrl) {
        console.log(chalk.hex('#8a7768')(`  ↪ Base URL normalized to ${chalk.hex('#ede0cc')(normalized)}`));
      }
      baseUrl = normalized;
    }
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      console.log(chalk.hex('#b15439')(`  ✗ Base URL must start with http:// or https:// (got "${baseUrl}").`));
      return null;
    }

    if (provider.name === 'Xiaomi MiMo') {
      const norm = normalizeXiaomiWizardConfig(effectiveModel, apiKey ?? undefined, baseUrl, xiaomiRegion);
      effectiveModel = norm.model;
      baseUrl = norm.baseUrl;
      if (norm.note) {
        console.log(chalk.hex('#8a7768')(`  ↪ ${norm.note}\n`));
      }
    }

    if (!baseUrl && provider.name === 'Custom endpoint') {
      console.log(chalk.hex('#b15439')('  ✗ Base URL is required for custom endpoints.'));
      return null;
    }

    const config: ProviderConfig = {
      provider: provider.name,
      model: effectiveModel,
      baseUrl: baseUrl || provider.baseUrl,
      apiKey: apiKey ?? undefined,
    };

    // ── Step 4: Test Connection ─────────────────────────────────────────────
    const saved = await testAndSave(rl, config, askInputFn, provider);
    return saved;
  } finally {
    if (!existingRl) {
      rl.close();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Provider Selection
// ─────────────────────────────────────────────────────────────────────────────

async function selectProvider(rl: readline.Interface, askInputFn?: (prompt: string) => Promise<string>): Promise<ProviderEntry | null> {
  console.log(chalk.hex('#cc785c')('  Step 1: Select your AI provider\n'));

  const items = PROVIDER_REGISTRY.map((p, i) => {
    const num = chalk.hex('#8a7768')(String(i + 1).padStart(2) + '.');
    const name = chalk.hex('#e8d5b7')(p.name);
    return `  ${num} ${name}`;
  });
  for (const item of items) {
    console.log(item);
  }
  console.log();

  const choice = await askInput(rl, '  ▸ Choose a number: ', askInputFn);
  const idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= PROVIDER_REGISTRY.length || !Number.isFinite(idx)) {
    console.log(chalk.hex('#b15439')('  ✗ Invalid choice.'));
    return null;
  }
  return PROVIDER_REGISTRY[idx];
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Model Selection
// ─────────────────────────────────────────────────────────────────────────────

async function selectModel(rl: readline.Interface, provider: ProviderEntry, askInputFn?: (prompt: string) => Promise<string>): Promise<string | null> {
  // Custom endpoint — user types model ID
  if (provider.name === 'Custom endpoint') {
    console.log(chalk.hex('#cc785c')('\n  Step 2: Enter model ID\n'));
    const modelId = await askInput(rl, '  ▸ Model ID: ', askInputFn);
    if (!modelId) {
      console.log(chalk.hex('#b15439')('  ✗ Model ID is required.'));
      return null;
    }
    return modelId;
  }

  // Ollama — auto-detect from running instance
  if (provider.name === 'Ollama (local, free)') {
    console.log(chalk.hex('#cc785c')('\n  Step 2: Select model'));
    console.log(chalk.hex('#8a7768')('  Detecting models from Ollama...\n'));
    const ollamaModels = await detectOllamaModels();
    if (ollamaModels.length === 0) {
      console.log(chalk.hex('#b15439')('  Ollama doesn\'t seem to be running, or has no models.'));
      console.log(chalk.hex('#8a7768')('  Start it first: ollama serve'));
      console.log(chalk.hex('#8a7768')('  Pull a model:   ollama pull llama3.2\n'));
      const manual = await askInput(rl, '  ▸ Enter model name manually (or press Enter to cancel): ');
      // Bare Ollama tags aren't routable — the factory needs the ollama/
      // prefix to pick the localhost endpoint instead of the OpenAI default.
      return manual ? (manual.startsWith('ollama/') ? manual : `ollama/${manual}`) : null;
    }
    for (let i = 0; i < ollamaModels.length; i++) {
      const num = chalk.hex('#8a7768')(String(i + 1).padStart(2) + '.');
      const name = chalk.hex('#e8d5b7')(ollamaModels[i]);
      console.log(`  ${num} ${name}`);
    }
    console.log();
    const choice = await askInput(rl, '  ▸ Choose a number: ', askInputFn);
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= ollamaModels.length || !Number.isFinite(idx)) {
      console.log(chalk.hex('#b15439')('  ✗ Invalid choice.'));
      return null;
    }
    return `ollama/${ollamaModels[idx]}`;
  }

  // Standard provider — show preset model list
  console.log(chalk.hex('#cc785c')(`\n  Step 2: Select model for ${provider.name}\n`));
  for (let i = 0; i < provider.models.length; i++) {
    const m = provider.models[i];
    const num = chalk.hex('#8a7768')(String(i + 1).padStart(2) + '.');
    const label = chalk.hex('#e8d5b7')(m.label);
    const speed = chalk.hex('#5a4a3a')(` (${m.speed})`);
    console.log(`  ${num} ${label}${speed}`);
  }
  console.log();
  const choice = await askInput(rl, '  ▸ Choose a number: ', askInputFn);
  const idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= provider.models.length || !Number.isFinite(idx)) {
    console.log(chalk.hex('#b15439')('  ✗ Invalid choice.'));
    return null;
  }
  return provider.models[idx].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: API Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the API key string, empty string for local providers, or null if cancelled.
 */
async function configureApiKey(rl: readline.Interface, provider: ProviderEntry, askInputFn?: (prompt: string) => Promise<string>): Promise<string | null> {
  // No key needed for Ollama / local
  if (!provider.envKey) {
    return '';
  }

  console.log(chalk.hex('#cc785c')('\n  Step 3: API Key\n'));

  const existingKey = detectExistingKey(provider);
  if (existingKey) {
    // Key found — offer keep/replace
    console.log(chalk.hex('#8a7768')(`  API key found: ${chalk.hex('#5a9e6e')(maskApiKey(existingKey))}`));
    console.log(chalk.hex('#8a7768')(`  Source: environment (${provider.envKey})\n`));
    console.log(chalk.hex('#8a7768')('   1. Keep this key'));
    console.log(chalk.hex('#8a7768')('   2. Replace with new key\n'));
    const choice = await askInput(rl, '  ▸ Choose (1 or 2): ', askInputFn);
    if (choice === '2') {
      const newKey = await askSecretInput(rl, '  ▸ Enter new API key: ');
      if (!newKey) {
        console.log(chalk.hex('#b15439')('  ✗ No key provided.'));
        return null;
      }
      return newKey;
    }
    return existingKey;
  }

  // No key found — prompt for one
  console.log(chalk.hex('#8a7768')(`  No API key found for ${provider.name}.`));
  if (provider.signupUrl) {
    console.log(chalk.hex('#8a7768')(`  Get one at: ${chalk.hex('#cc785c')(provider.signupUrl)}\n`));
  }
  const newKey = await askSecretInput(rl, '  ▸ Enter API key: ');
  if (!newKey) {
    console.log(chalk.hex('#b15439')('  ✗ No key provided.'));
    return null;
  }
  return newKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Test Connection & Save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test the connection, then save — or offer the remedy that actually fits the
 * failure.
 *
 * The old menu offered "re-enter API key" for every failure, which is how a
 * valid key came to look permanently rejected: OpenAI answers an unpaid account
 * with 429 "exceeded your current quota", OpenCode Zen answers one with 401
 * "Insufficient balance", and a retired gateway model answers 500 — none of
 * which a different key can fix. Each failure kind now leads with the step that
 * can.
 */
async function testAndSave(
  rl: readline.Interface,
  config: ProviderConfig,
  askInputFn?: (prompt: string) => Promise<string>,
  provider?: ProviderEntry,
): Promise<ProviderConfig | null> {
  console.log(chalk.hex('#cc785c')(`\n  Testing connection to ${config.provider}...`));

  const result = await testProviderConnection({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });

  if (result.ok) {
    console.log(chalk.hex('#5a9e6e')('  ✓ Connected! Model responds.'));
    saveProviderConfig(config);
    console.log(chalk.hex('#8a7768')(`\n  Saved to ${globalConfigPath()}\n`));
    return config;
  }

  const kind: TestFailureKind = result.kind ?? 'auth';
  const dim = chalk.hex('#8a7768');
  const bad = chalk.hex('#b15439');

  // Headline: name what actually went wrong, and say plainly when the key is
  // not the problem — otherwise the user retypes it forever.
  const headline: Record<TestFailureKind, string> = {
    auth: 'Authentication failed — the provider rejected this key.',
    billing: 'Your key works. The account has no credit or quota left.',
    rate: 'Your key works. The provider is rate-limiting right now.',
    model: `Your key works. The model "${config.model}" is not available on this endpoint.`,
    server: 'Your key reached the provider, but the provider returned an error.',
    network: 'Never reached the provider — check the base URL and your connection.',
  };
  console.log(bad(`  ✗ ${headline[kind]}`));
  console.log(dim(`    ${result.error}\n`));

  // Remedies, most-likely-to-help first for this kind.
  type Remedy = 'key' | 'model' | 'retry' | 'save' | 'cancel';
  const order: Record<TestFailureKind, Remedy[]> = {
    auth: ['key', 'save', 'cancel'],
    billing: ['save', 'retry', 'key', 'cancel'],
    rate: ['retry', 'save', 'cancel'],
    model: ['model', 'retry', 'save', 'cancel'],
    server: ['retry', 'save', 'cancel'],
    network: ['retry', 'save', 'cancel'],
  };
  const text: Record<Remedy, string> = {
    key: 'Re-enter API key',
    model: 'Choose a different model',
    retry: 'Test again',
    save: 'Save anyway (skip the test)',
    cancel: 'Cancel',
  };

  // "Choose a different model" only makes sense against a preset list.
  const remedies = order[kind].filter(r => r !== 'model' || (provider?.models?.length ?? 0) > 1);
  remedies.forEach((r, i) => console.log(dim(`   ${i + 1}. ${text[r]}`)));
  console.log();

  const answer = await askInput(rl, `  ▸ Choose (1-${remedies.length}) [1]: `, askInputFn);
  const picked = remedies[(parseInt(answer.trim(), 10) || 1) - 1] ?? 'cancel';

  if (picked === 'key') {
    const newKey = await askSecretInput(rl, '  ▸ Enter new API key: ');
    if (!newKey) return null;
    config.apiKey = newKey;
    return testAndSave(rl, config, askInputFn, provider);
  }
  if (picked === 'model' && provider) {
    const newModel = await selectModel(rl, provider, askInputFn);
    if (!newModel) return null;
    config.model = newModel;
    return testAndSave(rl, config, askInputFn, provider);
  }
  if (picked === 'retry') {
    return testAndSave(rl, config, askInputFn, provider);
  }
  if (picked === 'save') {
    saveProviderConfig(config);
    console.log(dim(`\n  Saved to ${globalConfigPath()} (connection not verified)\n`));
    return config;
  }
  return null; // Cancel
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompts for a line of input. Disables terminal bracketed-paste mode for
 * the duration of the prompt — on terminals where bracketed-paste escape
 * sequences interact badly with Node's raw TTY read, pasted text (API
 * keys, model IDs, anything multi-character) can arrive duplicated and
 * case-mangled. A short settle delay on each side avoids dropping the
 * first/last character right at the paste boundary. Well-behaved
 * terminals are unaffected either way.
 */
function askInput(rl: readline.Interface, prompt: string, askInputFn?: (prompt: string) => Promise<string>): Promise<string> {
  // Use TUI's askInput function if provided (running in TUI mode)
  if (askInputFn) {
    return askInputFn(prompt);
  }

  // Fall back to default readline behavior
  const canToggle = process.stdout.isTTY;
  if (canToggle) process.stdout.write('\x1b[?2004l'); // disable bracketed paste
  return new Promise(resolve => {
    setTimeout(() => {
      rl.question(chalk.hex('#cc785c')(prompt), answer => {
        setTimeout(() => {
          if (canToggle) process.stdout.write('\x1b[?2004h'); // re-enable
          resolve((answer ?? '').trim());
        }, 30);
      });
    }, 30);
  });
}

/**
 * Read a secret (API key) without putting it on screen in clear text.
 *
 * Echoes one `*` per character so a paste is visibly *received* — the previous
 * behaviour was a plain alias for askInput, which left the caller staring at a
 * prompt that looked like it had swallowed the paste.
 *
 * Takes stdin directly in raw mode for the duration rather than going through
 * readline: readline echoes what it reads, and there is no supported way to
 * make it echo something else. The interface is paused first so the two are
 * never both reading — that contention is exactly what makes pasting into this
 * wizard feel unreliable.
 *
 * Falls back to askInput when stdin is not a TTY (piped input, CI), where raw
 * mode is unavailable and there is no terminal to hide the value from anyway.
 */
function askSecretInput(rl: readline.Interface, prompt: string): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return askInput(rl, prompt);
  }

  return new Promise<string>(resolve => {
    process.stdout.write(chalk.hex('#cc785c')(prompt));

    const wasRaw = stdin.isRaw === true;
    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';

    const finish = (value: string): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      if (!wasRaw) stdin.pause();
      process.stdout.write('\n');
      rl.resume();
      resolve(value.trim());
    };

    const onData = (chunk: Buffer): void => {
      // Drop CSI/escape sequences wholesale: bracketed-paste markers
      // (\x1b[200~ … \x1b[201~) and any stray arrow keys would otherwise land
      // in the key as literal bytes.
      const text = chunk.toString('utf8').replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '');

      for (const ch of text) {
        if (ch === '\r' || ch === '\n') { finish(buf); return; }
        if (ch === '\x03') { finish(''); return; }          // Ctrl-C — cancel
        if (ch === '\x04') { finish(buf); return; }         // Ctrl-D — submit
        if (ch === '\x7f' || ch === '\b') {                 // Backspace
          if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch === '\x15') {                                // Ctrl-U — clear
          process.stdout.write('\b \b'.repeat(buf.length));
          buf = '';
          continue;
        }
        if (ch < ' ') continue;                             // other control chars
        buf += ch;
        process.stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

/** Internals exposed for tests only — not part of the module's public surface. */
export const __testing = { askSecretInput };

/**
 * Save the provider config to ~/.config/aura-code/config.json and export
 * the API key env var for the current process.
 *
 * Exported so non-TUI front ends (the `setup --web` wizard the installers
 * launch) persist through exactly this path — key store, global config, and
 * provider.json all written the same way, rather than each caller
 * reimplementing three writes and drifting.
 */
export function saveProviderConfig(config: ProviderConfig): void {
  // Find the matching provider entry to get apiKeyEnv
  const entry = PROVIDER_REGISTRY.find(p => p.name === config.provider);
  const apiKeyEnv = entry?.envKey ?? '';

  // Persist the key in the key store (also exports it into process.env).
  // Keys never land in provider.json — that file is world-readable config.
  if (config.apiKey && apiKeyEnv) {
    saveKey(apiKeyEnv, config.apiKey);
    process.env[apiKeyEnv.toLowerCase()] = config.apiKey;
  }

  // Save to global config
  saveGlobalConfig({
    provider: config.provider,
    apiKeyEnv,
    defaultModel: config.model,
    baseUrl: config.baseUrl || undefined,
  });

  // Also save the full provider config (including apiKey) to a separate
  // section in the config directory so the factory can read it.
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'aura-code')
    : path.join(os.homedir(), '.config', 'aura-code');
  fs.mkdirSync(configDir, { recursive: true });
  const providerCfg = {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  };
  fs.writeFileSync(
    path.join(configDir, 'provider.json'),
    JSON.stringify(providerCfg, null, 2) + '\n',
    { mode: 0o600 },
  );
}

/**
 * Load saved provider config from the config directory.
 */
export function loadProviderConfig(): ProviderConfig | null {
  try {
    const configDir = process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'aura-code')
      : path.join(os.homedir(), '.config', 'aura-code');
    const filePath = path.join(configDir, 'provider.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ProviderConfig;
    if (!parsed.provider || !parsed.model) return null;
    // Legacy files stored the key in plaintext here — migrate it into the
    // key store once and strip it from the file.
    if (parsed.apiKey) {
      const entry = PROVIDER_REGISTRY.find(p => p.name === parsed.provider);
      if (entry?.envKey) {
        try {
          saveKey(entry.envKey, parsed.apiKey);
          const { apiKey: _dropped, ...rest } = parsed;
          fs.writeFileSync(filePath, JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
        } catch { /* keep the legacy file as-is; runtime still works via parsed.apiKey */ }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Auto-detect models from a running Ollama instance.
 */
async function detectOllamaModels(): Promise<string[]> {
  return new Promise(resolve => {
    const req = http.get('http://localhost:11434/api/tags', { timeout: 5_000 }, res => {
      if (res.statusCode !== 200) {
        resolve([]);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models ?? []).map((m: { name: string }) => m.name);
          resolve(models);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

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
import { PROVIDER_REGISTRY, detectExistingKey, maskApiKey } from './provider-registry.js';
import type { ProviderEntry } from './provider-registry.js';
import { testProviderConnection } from './provider-test.js';
import { saveGlobalConfig, globalConfigPath } from './global-config.js';
import { defaultXiaomiBaseUrl, normalizeXiaomiWizardConfig } from './xiaomi.js';

export interface ProviderConfig {
  provider: string;   // Display name
  model: string;      // Model ID
  baseUrl: string;    // API endpoint
  apiKey?: string;    // API key (undefined for Ollama)
}

/**
 * Run the full 4-step provider wizard.
 *
 * Returns the chosen config on success, or null if the user cancelled.
 */
export async function runProviderWizard(existingRl?: readline.Interface): Promise<ProviderConfig | null> {
  const rl = existingRl || readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(chalk.hex('#cc785c')('\n  ✦  Provider Setup Wizard'));
    console.log(chalk.hex('#8a7768')('  Configure your AI provider in 3 easy steps.\n'));

    // ── Step 1: Select Provider ─────────────────────────────────────────────
    const provider = await selectProvider(rl);
    if (!provider) return null;

    // ── Step 2: Select Model ────────────────────────────────────────────────
    const model = await selectModel(rl, provider);
    if (!model) return null;

    // ── Step 3: API Key ─────────────────────────────────────────────────────
    const apiKey = await configureApiKey(rl, provider);
    if (apiKey === null && provider.envKey !== null) return null; // Cancelled (needed key but got null)

    let effectiveModel = model;

    // Build baseUrl
    let baseUrlPrompt = '  ▸ Enter base URL: ';
    const defaultBase = provider.name === 'Xiaomi MiMo'
      ? defaultXiaomiBaseUrl(apiKey ?? undefined)
      : (provider.baseUrl || '');
    if (defaultBase) {
      baseUrlPrompt = `  ▸ Enter base URL [press Enter to use default ${chalk.hex('#ede0cc')(defaultBase)}]: `;
    }
    const enteredUrl = await askInput(rl, baseUrlPrompt);
    let baseUrl = enteredUrl.trim() || defaultBase || provider.baseUrl || '';

    if (provider.name === 'Xiaomi MiMo') {
      const norm = normalizeXiaomiWizardConfig(effectiveModel, apiKey ?? undefined, baseUrl);
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
    const saved = await testAndSave(rl, config);
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

async function selectProvider(rl: readline.Interface): Promise<ProviderEntry | null> {
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

  const choice = await askInput(rl, '  ▸ Choose a number: ');
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

async function selectModel(rl: readline.Interface, provider: ProviderEntry): Promise<string | null> {
  // Custom endpoint — user types model ID
  if (provider.name === 'Custom endpoint') {
    console.log(chalk.hex('#cc785c')('\n  Step 2: Enter model ID\n'));
    const modelId = await askInput(rl, '  ▸ Model ID: ');
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
      return manual || null;
    }

    for (let i = 0; i < ollamaModels.length; i++) {
      const num = chalk.hex('#8a7768')(String(i + 1).padStart(2) + '.');
      const name = chalk.hex('#e8d5b7')(ollamaModels[i]);
      console.log(`  ${num} ${name}`);
    }
    console.log();

    const choice = await askInput(rl, '  ▸ Choose a number: ');
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= ollamaModels.length || !Number.isFinite(idx)) {
      console.log(chalk.hex('#b15439')('  ✗ Invalid choice.'));
      return null;
    }
    return ollamaModels[idx];
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

  const choice = await askInput(rl, '  ▸ Choose a number: ');
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
async function configureApiKey(rl: readline.Interface, provider: ProviderEntry): Promise<string | null> {
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

    const choice = await askInput(rl, '  ▸ Choose (1 or 2): ');
    if (choice === '2') {
      const newKey = await askInput(rl, '  ▸ Enter new API key: ');
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

  const newKey = await askInput(rl, '  ▸ Enter API key: ');
  if (!newKey) {
    console.log(chalk.hex('#b15439')('  ✗ No key provided.'));
    return null;
  }
  return newKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Test Connection & Save
// ─────────────────────────────────────────────────────────────────────────────

async function testAndSave(rl: readline.Interface, config: ProviderConfig): Promise<ProviderConfig | null> {
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

  // Connection failed — offer retry/skip/cancel
  console.log(chalk.hex('#b15439')(`  ✗ Connection failed: ${result.error}\n`));

  console.log(chalk.hex('#8a7768')('   1. Re-enter API key'));
  console.log(chalk.hex('#8a7768')('   2. Skip test and save anyway'));
  console.log(chalk.hex('#8a7768')('   3. Cancel\n'));

  const choice = await askInput(rl, '  ▸ Choose (1, 2, or 3): ');

  if (choice === '1') {
    const newKey = await askInput(rl, '  ▸ Enter new API key: ');
    if (!newKey) return null;
    config.apiKey = newKey;
    return testAndSave(rl, config); // Recursive retry
  }

  if (choice === '2') {
    saveProviderConfig(config);
    console.log(chalk.hex('#8a7768')(`\n  Saved to ${globalConfigPath()} (connection not verified)\n`));
    return config;
  }

  return null; // Cancel
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(chalk.hex('#cc785c')(prompt), answer => {
      resolve((answer ?? '').trim());
    });
  });
}

/**
 * Save the provider config to ~/.config/aura-code/config.json and export
 * the API key env var for the current process.
 */
function saveProviderConfig(config: ProviderConfig): void {
  // Find the matching provider entry to get apiKeyEnv
  const entry = PROVIDER_REGISTRY.find(p => p.name === config.provider);
  const apiKeyEnv = entry?.envKey ?? '';

  // Export API key as env var for the current process
  if (config.apiKey && apiKeyEnv) {
    process.env[apiKeyEnv] = config.apiKey;
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
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
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
    const raw = fs.readFileSync(path.join(configDir, 'provider.json'), 'utf8');
    const parsed = JSON.parse(raw) as ProviderConfig;
    if (!parsed.provider || !parsed.model) return null;
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

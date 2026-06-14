/**
 * Global Aura configuration (user-wide, not project-specific).
 *
 * Lives at `$XDG_CONFIG_HOME/aura-code/config.json` (default `~/.config/aura-code/config.json`).
 * Holds the user's default provider + API key + default model, set by the
 * first-run wizard so subsequent runs don't re-prompt.
 *
 * Project-level `.aura.json` still wins on a per-project basis; this file
 * is just the "no project context" fallback.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface GlobalConfig {
  /** Default provider: 'anthropic' | 'openai' | 'google' | 'xai' | 'xiaomi' | 'openrouter' | 'ollama' | 'local' */
  provider: string;
  /** Provider-specific env var name (e.g. 'ANTHROPIC_API_KEY', 'XIAOMI_API_KEY') */
  apiKeyEnv: string;
  /** Default model id (e.g. 'claude-sonnet-4-5-20251001', 'mimo-v2.5-pro') */
  defaultModel: string;
  /** Optional custom base URL (Xiaomi, OpenRouter, Ollama, etc.) */
  baseUrl?: string;
  /** When the user first set this up (ISO timestamp) */
  createdAt: string;
  /** Last updated (ISO timestamp) */
  updatedAt: string;
}

const EMPTY: GlobalConfig = {
  provider: '',
  apiKeyEnv: '',
  defaultModel: '',
  createdAt: '',
  updatedAt: '',
};

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'aura-code') : path.join(os.homedir(), '.config', 'aura-code');
}

function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function loadGlobalConfig(): GlobalConfig | null {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as GlobalConfig;
    if (!parsed.provider || !parsed.apiKeyEnv || !parsed.defaultModel) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveGlobalConfig(cfg: Omit<GlobalConfig, 'createdAt' | 'updatedAt'> & { createdAt?: string }): GlobalConfig {
  const now = new Date().toISOString();
  const existing = loadGlobalConfig();
  const full: GlobalConfig = {
    ...EMPTY,
    ...cfg,
    createdAt: cfg.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(full, null, 2) + '\n', { mode: 0o600 });
  // Also export the API key env var for this process so the rest of the run works.
  // The user is expected to have set the actual key in their shell; we only export
  // if it's already in process.env under any casing.
  return full;
}

export function globalConfigPath(): string {
  return configPath();
}

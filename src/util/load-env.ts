import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Load KEY=VALUE pairs from a .env-style file into process.env.
 * Does not override variables that are already set (non-empty).
 */
export function loadEnvFile(filePath: string): void {
  if (!filePath || !fs.existsSync(filePath)) return;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const existing = process.env[key];
    if (existing !== undefined && existing.trim() !== '') continue;
    process.env[key] = value;
  }
}

/**
 * Bootstrap API keys for Aura from common locations (Hermes, project, XDG).
 * Safe to call multiple times.
 */
export function bootstrapAuraEnv(cwd?: string): void {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.hermes', '.env'),
    path.join(home, '.config', 'aura-code', '.env'),
  ];
  if (cwd) {
    candidates.push(path.join(path.resolve(cwd), '.env'));
  }
  for (const p of candidates) {
    loadEnvFile(p);
  }
}
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Provider-agnostic env-var reader.
 *
 * Tries, in order:
 *   1. The canonical UPPER_SNAKE_CASE var (most SDKs read this)
 *   2. The lowercase variant (some shells / dotenv loaders normalise to this)
 *   3. Common alternates passed as `aliases`
 *
 * Returns `undefined` if none are set, never throws. Returns `undefined`
 * (NOT '') for empty / whitespace / placeholder values, so callers can use
 * the `??` operator and have it fall through to the next fallback.
 */
export function getApiKey(canonical: string, ...aliases: string[]): string | undefined {
  const names = [canonical, canonical.toLowerCase(), ...aliases];
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim() && v !== 'your_api_key_here') return v;
  }
  return undefined;
}

/**
 * Same idea for non-secret env vars (base URLs, model names).
 * Returns `undefined` for unset / empty / whitespace, so `??` chains work.
 */
export function getEnv(canonical: string, ...aliases: string[]): string | undefined {
  const names = [canonical, canonical.toLowerCase(), ...aliases];
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim()) return v;
  }
  return undefined;
}

/**
 * Persist an env var to ~/.secrets/agents.env (the file auto-loaded at CLI
 * startup) and set it in the live process.env. Replaces an existing
 * `KEY=...` line in place (also `export KEY=...`), otherwise appends.
 * Creates the directory/file with owner-only permissions on first write.
 * Returns the file path written.
 */
export function saveToAgentsEnv(key: string, value: string): string {
  const dir = path.join(os.homedir(), '.secrets');
  const file = path.join(dir, 'agents.env');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let lines: string[] = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  }

  const newLine = `${key}=${value}`;
  let replaced = false;
  lines = lines.map(line => {
    const t = line.trim();
    if (t.startsWith('#')) return line;
    const m = t.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && m[2] === key && !replaced) {
      replaced = true;
      return (m[1] ?? '') + newLine;
    }
    return line;
  });
  if (!replaced) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(newLine);
  }
  if (lines[lines.length - 1] !== '') lines.push('');

  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  process.env[key] = value;
  return file;
}

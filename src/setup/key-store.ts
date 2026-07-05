import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Persistent API-key store — ~/.aura/keys.json
//
// Aura resolves keys from process.env (see util/env.ts), which means a key only
// survives if it's exported in a shell rc / environment.d file. That's fragile:
// a key set with :apikey vanished on exit, and keys scattered across .bashrc vs
// environment.d meant some sessions couldn't see them (the recurring "type the
// key every time" pain). This store fixes it: keys live in one file, loaded
// into process.env at startup so every run and every provider sees them.
//
// Precedence: a key already present in the real environment WINS (so a shell
// export or a per-run `KEY=… aura` override is never clobbered by the store).
// ─────────────────────────────────────────────────────────────────────────────

function keyStorePath(): string {
  return path.join(os.homedir(), '.aura', 'keys.json');
}

type KeyMap = Record<string, string>;

function readStore(): KeyMap {
  try {
    const p = keyStorePath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge stored keys into process.env WITHOUT overriding anything already set
 * in the real environment. Call once at startup, before any provider is built.
 */
export function loadKeysIntoEnv(): void {
  const store = readStore();
  for (const [name, value] of Object.entries(store)) {
    if (!value || !String(value).trim()) continue;
    const existing = process.env[name];
    if (existing && existing.trim()) continue; // real env wins
    process.env[name] = String(value);
  }
}

/**
 * Persist a key to the store AND set it live in this process. Written with 0600
 * perms (secrets). Returns the file path.
 */
export function saveKey(name: string, value: string): string {
  const store = readStore();
  store[name] = value;
  const p = keyStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  process.env[name] = value; // live immediately
  return p;
}

/** Names of keys currently in the store (values never returned/logged). */
export function listKeyNames(): string[] {
  return Object.keys(readStore());
}

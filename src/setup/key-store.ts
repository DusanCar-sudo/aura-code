import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { auraPath } from '../util/aura-home.js';

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
// Precedence: the STORE wins over the inherited environment. It used to be the
// other way round, and that is how a key saved with :apikey kept losing to a
// dead `export` left in ~/.bashrc or environment.d — every new session quietly
// used the old key (OpenRouter, Groq and Xiaomi all hit this). A key saved in
// Aura is the key Aura uses. AURA_KEYS_ENV_WINS=1 restores the old order for a
// deliberate per-run `KEY=… aura` override.
//
// Running sessions follow the file too: once loadKeysIntoEnv has run, a change
// to keys.json made by another session is picked up on the next key lookup,
// and currentKey() lets an already-built provider swap a replaced key for the
// new one without a restart.
// ─────────────────────────────────────────────────────────────────────────────

function keyStorePath(): string {
  return auraPath('keys.json');
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

/** mtime of keys.json when last applied; null until loadKeysIntoEnv runs, which
 *  keeps the live refresh inert in tests and library use. */
let appliedMtime: number | null = null;
/** Key values the store has replaced in this process → their replacement. */
const superseded = new Map<string, string>();

function storeMtime(): number {
  try { return fs.statSync(keyStorePath()).mtimeMs; } catch { return 0; }
}

function setLive(name: string, value: string): void {
  const prev = process.env[name];
  if (prev && prev !== value) superseded.set(prev, value);
  // The new value is current now, not superseded — keeps a revert (A→B→A)
  // from leaving a cycle in the map.
  superseded.delete(value);
  process.env[name] = value;
}

function applyStore(): void {
  const envWins = process.env.AURA_KEYS_ENV_WINS === '1';
  for (const [name, value] of Object.entries(readStore())) {
    if (!value || !String(value).trim()) continue;
    const existing = process.env[name];
    if (envWins && existing && existing.trim()) continue;
    setLive(name, String(value));
  }
}

/**
 * Merge stored keys into process.env, overriding inherited values (see the
 * precedence note above). Call once at startup, before any provider is built.
 */
export function loadKeysIntoEnv(): void {
  appliedMtime = storeMtime();
  applyStore();
}

/** Re-apply keys.json if another process changed it since it was last read.
 *  A no-op until loadKeysIntoEnv has run. */
export function refreshKeysFromStore(): void {
  if (appliedMtime === null) return;
  const m = storeMtime();
  if (m === appliedMtime) return;
  appliedMtime = m;
  applyStore();
}

/** The key to use in place of `key`: its replacement if the store has since
 *  replaced it, otherwise `key` itself. For providers holding a key they
 *  resolved at construction. */
export function currentKey(key: string): string {
  refreshKeysFromStore();
  return superseded.get(key) ?? key;
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
  if (value) setLive(name, value); // live immediately
  else process.env[name] = value;
  if (appliedMtime !== null) appliedMtime = storeMtime(); // our own write, already applied
  return p;
}

/** Names of keys currently in the store (values never returned/logged). */
export function listKeyNames(): string[] {
  return Object.keys(readStore());
}

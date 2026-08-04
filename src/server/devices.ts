import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Registry of phones (and other clients) allowed to drive this desktop.
 *
 * `aura serve` also mints a per-run token for its own browser UI, but that
 * token dies with the process and identifies nobody — every holder of it is
 * the same anonymous client. Once a second person is involved that is not
 * enough: their conversation, their spend, and above all *their* approval
 * prompts have to be told apart from yours, and that needs a durable
 * per-device identity.
 *
 * Only the SHA-256 of each token is stored. The token itself is shown once,
 * at pairing time, and is unrecoverable afterwards — a stolen registry file
 * yields no working credential. Revoking is deleting the row.
 */
export interface PairedDevice {
  /** Short opaque id, used by `aura devices revoke`. */
  id: string;
  /** Human label chosen at pairing time, e.g. "Mum's phone". */
  name: string;
  /** SHA-256 of the bearer token, hex. Never the token itself. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * A short code someone can actually type on a phone, exchanged once for a
 * real token.
 *
 * The bearer token is 48 hex characters because it has to resist guessing;
 * that is also miserable to thumb in. So the human types this instead, and
 * the phone trades it for the long token over loopback and stores that. The
 * short string is only guessable for as long as it lives: single use, ten
 * minutes, and burned after a handful of wrong tries — which is what makes
 * six characters enough here and would not make a six-character *token* safe.
 */
export interface PendingPairing {
  code: string;
  name: string;
  expiresAt: string;
  attempts: number;
}

/** Excludes 0/O and 1/I/L — they get mistyped off a screen. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

interface RegistryFile {
  version: 1;
  devices: PairedDevice[];
  pairings?: PendingPairing[];
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'aura-code') : path.join(os.homedir(), '.config', 'aura-code');
}

export function devicesPath(): string {
  return path.join(configDir(), 'paired-devices.json');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function readRegistry(): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(devicesPath(), 'utf8')) as RegistryFile;
    return {
      version: 1,
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      pairings: Array.isArray(parsed.pairings) ? parsed.pairings : [],
    };
  } catch {
    // Absent or unreadable registry means nothing is paired, which is the
    // correct starting state — not an error worth failing `aura serve` over.
    return { version: 1, devices: [], pairings: [] };
  }
}

function writeRegistry(file: RegistryFile): void {
  fs.mkdirSync(configDir(), { recursive: true });
  // 0600: this file gates control of the machine. Even hashed, the names and
  // ids are worth keeping to the owner.
  fs.writeFileSync(devicesPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

export function loadDevices(): PairedDevice[] {
  return readRegistry().devices;
}

function saveDevices(devices: PairedDevice[]): void {
  writeRegistry({ ...readRegistry(), devices });
}

/**
 * Mint a device token. Returns the plaintext token exactly once — it is not
 * stored and cannot be shown again.
 */
export function addDevice(name: string): { device: PairedDevice; token: string } {
  const token = crypto.randomBytes(24).toString('hex');
  const device: PairedDevice = {
    id: crypto.randomBytes(4).toString('hex'),
    name: name.trim() || 'Unnamed device',
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  saveDevices([...loadDevices(), device]);
  return { device, token };
}

/** Returns true if a device was removed. */
export function revokeDevice(idOrName: string): PairedDevice | null {
  const devices = loadDevices();
  const needle = idOrName.trim().toLowerCase();
  const match = devices.find(d => d.id === needle || d.name.toLowerCase() === needle);
  if (!match) return null;
  saveDevices(devices.filter(d => d !== match));
  return match;
}

/**
 * Identify the device holding `token`, or null.
 *
 * Compared with timingSafeEqual over the digests rather than `===`: the
 * digests are fixed-length, so this leaks nothing through comparison time,
 * and the cost is negligible against the number of paired devices.
 */
export function findDeviceByToken(token: string): PairedDevice | null {
  if (!token) return null;
  const provided = Buffer.from(hashToken(token), 'hex');
  for (const device of loadDevices()) {
    let stored: Buffer;
    try { stored = Buffer.from(device.tokenHash, 'hex'); } catch { continue; }
    if (stored.length !== provided.length) continue;
    if (crypto.timingSafeEqual(stored, provided)) return device;
  }
  return null;
}

/**
 * Start a pairing: returns the short code to read out to the phone.
 *
 * The device row does not exist yet — it is created on redemption, so an
 * unused or expired code leaves nothing behind and grants nothing.
 */
export function createPairingCode(name: string): PendingPairing {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];

  const pairing: PendingPairing = {
    code,
    name: name.trim() || 'Unnamed device',
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    attempts: 0,
  };

  const file = readRegistry();
  const live = (file.pairings ?? []).filter(p => new Date(p.expiresAt).getTime() > Date.now());
  writeRegistry({ ...file, pairings: [...live, pairing] });
  return pairing;
}

/**
 * Exchange a code for a real device token. Returns null for anything not
 * currently redeemable — unknown, expired, or too often guessed.
 *
 * Single use: the code is removed whether or not it succeeded, so a code
 * that has done its job cannot pair a second phone.
 */
export function redeemPairingCode(code: string): { device: PairedDevice; token: string } | null {
  const file = readRegistry();
  const pairings = file.pairings ?? [];
  const wanted = code.trim().toUpperCase();
  const now = Date.now();

  // Expired codes go regardless of what was submitted.
  const live = pairings.filter(p => new Date(p.expiresAt).getTime() > now);
  const match = live.find(p => p.code === wanted);

  if (!match) {
    // A wrong guess costs every outstanding code an attempt, so guessing
    // cannot be spread across codes to buy more tries.
    for (const p of live) p.attempts += 1;
    writeRegistry({ ...file, pairings: live.filter(p => p.attempts < MAX_ATTEMPTS) });
    return null;
  }

  writeRegistry({ ...file, pairings: live.filter(p => p !== match) });
  return addDevice(match.name);
}

/** Codes still awaiting a phone, expired ones dropped. */
export function pendingPairings(): PendingPairing[] {
  const now = Date.now();
  return (readRegistry().pairings ?? []).filter(p => new Date(p.expiresAt).getTime() > now);
}

/** Record that a device connected. Best-effort; never throws. */
export function touchDevice(id: string): void {
  try {
    const devices = loadDevices();
    const device = devices.find(d => d.id === id);
    if (!device) return;
    device.lastSeenAt = new Date().toISOString();
    saveDevices(devices);
  } catch {
    // A bookkeeping timestamp is never worth failing a live connection over.
  }
}

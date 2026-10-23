import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLanCert } from '../../src/server/lan.js';

/**
 * The phone pins the certificate's exact SHA-256 and ignores its names, so any
 * reissue forces a fresh pairing code. Reissuing whenever the address set
 * changed (DHCP, or `--lan` one day and `--tailscale` the next) meant a new
 * code every few days. These pin "pair once, stay paired".
 */

let dir: string;
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lan-cert-'));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LAN certificate', () => {
  it('keeps the same fingerprint when the machine changes address', () => {
    const first = ensureLanCert(['192.168.1.5']);
    const moved = ensureLanCert(['100.64.0.7'], ['box.tail1234.ts.net']);
    expect(moved.fingerprint).toBe(first.fingerprint);
  });

  it('issues a new one when the stored certificate is unreadable', () => {
    const first = ensureLanCert(['192.168.1.5']);
    fs.writeFileSync(path.join(dir, 'aura-code', 'lan-cert.pem'), 'garbage');
    expect(ensureLanCert(['192.168.1.5']).fingerprint).not.toBe(first.fingerprint);
  });
});

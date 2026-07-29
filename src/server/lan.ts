import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * LAN exposure: choosing an address, and the certificate that protects it.
 *
 * On loopback the traffic never leaves the machine. Over Wi-Fi it carries the
 * project's source, shell output, and a bearer token past every other device
 * on the network, so the LAN listener is TLS-only and the phone pins the
 * certificate. There is no plaintext LAN mode to fall back to.
 */

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'aura-code') : path.join(os.homedir(), '.config', 'aura-code');
}

const CERT_PATH = (): string => path.join(configDir(), 'lan-cert.pem');
const KEY_PATH = (): string => path.join(configDir(), 'lan-key.pem');

/**
 * Interfaces that are not "the local network" even though they present a
 * routable IPv4: VPN tunnels, container bridges, virtual adapters. Binding one
 * of these would quietly publish the agent somewhere the user did not mean —
 * a Tailscale address in particular reaches every machine on their tailnet.
 */
const NON_LAN = /^(tailscale|docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|utun|zt|ham)/i;

export interface LanAddress { iface: string; address: string }

/** Candidate LAN addresses, most likely first. Empty when only loopback exists. */
export function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs || NON_LAN.test(iface)) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      found.push({ iface, address: a.address });
    }
  }
  // Wireless first: a phone pairing over Wi-Fi is the case this exists for.
  const rank = (i: string): number => (/^(wl|wlan|wlp|en0)/i.test(i) ? 0 : 1);
  return found.sort((x, y) => rank(x.iface) - rank(y.iface));
}

/** Pick the address to bind, honouring an explicit override. */
export function pickLanAddress(preferred?: string): LanAddress | null {
  const all = lanAddresses();
  if (preferred) return all.find(a => a.address === preferred) ?? null;
  return all[0] ?? null;
}

export interface LanCert { cert: string; key: string; fingerprint: string }

function fingerprintOf(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

/** True when the cert still covers this IP and is not near expiry. */
function certCovers(certPem: string, ip: string): boolean {
  try {
    const x = new crypto.X509Certificate(certPem);
    // subjectAltName reads like "IP Address:192.168.1.5" (or DNS:...).
    if (!(x.subjectAltName ?? '').includes(ip)) return false;
    const validTo = new Date(x.validTo).getTime();
    return Number.isFinite(validTo) && validTo - Date.now() > 7 * 24 * 3600_000;
  } catch {
    return false;
  }
}

/**
 * Load the LAN certificate, generating one if it is missing, expiring, or was
 * issued for a different address (which happens whenever DHCP moves the
 * machine). Regenerating changes the fingerprint, so paired phones have to be
 * re-paired — that is the correct failure: a changed key is exactly what
 * pinning is meant to notice.
 */
export function ensureLanCert(ip: string): LanCert {
  const certPath = CERT_PATH();
  const keyPath = KEY_PATH();

  try {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    if (certCovers(cert, ip)) return { cert, key, fingerprint: fingerprintOf(cert) };
  } catch {
    // Missing or unreadable — fall through and issue a new one.
  }

  fs.mkdirSync(configDir(), { recursive: true });
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec',
      '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '825',
      '-subj', `/CN=Aura (${ip})`,
      // The phone connects to a bare IP, so the address has to be an IP SAN;
      // a CN alone is ignored by every modern TLS stack.
      '-addext', `subjectAltName=IP:${ip}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
    ], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      'Could not generate the LAN certificate — is `openssl` installed and on PATH?\n'
      + String((e as { stderr?: Buffer }).stderr ?? e),
    );
  }

  // The private key authenticates this machine to every paired phone.
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);

  const cert = fs.readFileSync(certPath, 'utf8');
  const key = fs.readFileSync(keyPath, 'utf8');
  return { cert, key, fingerprint: fingerprintOf(cert) };
}

/** Short form for reading aloud or eyeballing against the phone. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').slice(0, 8).toUpperCase();
}

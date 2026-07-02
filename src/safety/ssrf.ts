import * as dns from 'dns';
import * as net from 'net';

/**
 * SSRF guard for the outbound HTTP tools (web_fetch, http_request).
 *
 * Without this, the agent can be steered — including by prompt injection in a
 * fetched page — to reach loopback services, RFC-1918 hosts, or the cloud
 * metadata endpoint (169.254.169.254) to steal IAM credentials, then exfil
 * them back out. We reject private/loopback/link-local targets, restrict the
 * protocol to http/https, and re-validate on every redirect hop.
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
]);

function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts;
  if (a === 0) return true;                       // 0.0.0.0/8 "this host"
  if (a === 10) return true;                      // 10.0.0.0/8 private
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                      // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);

  if (addr === '::1' || addr === '::') return true; // loopback / unspecified

  // IPv4-mapped (::ffff:a.b.c.d) — evaluate the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);

  if (addr.startsWith('fe8') || addr.startsWith('fe9')
    || addr.startsWith('fea') || addr.startsWith('feb')) return true; // fe80::/10 link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;    // fc00::/7 unique-local
  if (addr.startsWith('ff')) return true;                             // ff00::/8 multicast
  return false;
}

/** True if the literal IP is one we refuse to connect to. Unknown → blocked. */
export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

/**
 * Validate a URL for outbound use: http/https only, and its host must not
 * resolve to a blocked address. Returns the parsed URL on success.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new SsrfError(`Invalid URL: ${rawUrl}`); }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Blocked protocol: ${url.protocol} (only http/https allowed)`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`Blocked address: ${host}`);
    return url;
  }

  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    throw new SsrfError(`Blocked host: ${host}`);
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`Could not resolve host: ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfError(`Host ${host} resolves to blocked address ${a.address}`);
    }
  }
  return url;
}

export interface SafeFetchOptions {
  maxRedirects?: number;
}

/**
 * fetch() wrapper that enforces {@link assertUrlAllowed} before the request
 * and on every redirect hop. Redirects are followed manually (redirect:
 * 'manual') so a public URL can't 302 to a private/metadata address without
 * being re-checked.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let currentUrl = rawUrl;
  let redirects = 0;

  while (true) {
    await assertUrlAllowed(currentUrl);
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (isRedirect && location) {
      if (redirects >= maxRedirects) throw new SsrfError('Too many redirects');
      redirects++;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
}

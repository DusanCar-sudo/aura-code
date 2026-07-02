import { describe, it, expect } from 'vitest';
import { isBlockedIp, assertUrlAllowed, SsrfError } from '../src/safety/ssrf.js';

describe('isBlockedIp', () => {
  it('blocks IPv4 private / loopback / link-local / metadata ranges', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
      '198.18.0.1', '224.0.0.1', '240.0.0.1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback / link-local / ULA / mapped-private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', '::ffff:127.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks anything that is not a valid IP', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertUrlAllowed('ftp://example.com')).rejects.toThrow(SsrfError);
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(SsrfError);
  });

  it('rejects loopback and metadata by IP literal (no DNS needed)', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1/')).rejects.toThrow(SsrfError);
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(SsrfError);
    await expect(assertUrlAllowed('http://[::1]/')).rejects.toThrow(SsrfError);
  });

  it('rejects the literal hostname "localhost"', async () => {
    await expect(assertUrlAllowed('http://localhost:8080/')).rejects.toThrow(SsrfError);
  });

  it('allows a public IP literal', async () => {
    const u = await assertUrlAllowed('https://8.8.8.8/');
    expect(u.hostname).toBe('8.8.8.8');
  });

  it('rejects a malformed URL', async () => {
    await expect(assertUrlAllowed('http://')).rejects.toThrow(SsrfError);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { __testing } from '../../src/setup/provider-wizard.js';

/**
 * Masked API-key entry.
 *
 * The bug this pins: `askSecretInput` used to be a plain alias for `askInput`,
 * so a pasted key produced no visible feedback and readline stayed in the fight
 * for stdin. These tests drive the raw-mode reader directly with the byte
 * sequences a terminal actually delivers.
 */
describe('askSecretInput', () => {
  let stdin: any;
  let out: string;
  let writeSpy: any;
  let savedStdin: any;

  beforeEach(() => {
    out = '';
    savedStdin = process.stdin;
    stdin = new EventEmitter() as any;
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = vi.fn((v: boolean) => { stdin.isRaw = v; return stdin; });
    stdin.resume = vi.fn(() => stdin);
    stdin.pause = vi.fn(() => stdin);
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
      out += String(c); return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: savedStdin, configurable: true });
  });

  const rl = () => ({ pause: vi.fn(), resume: vi.fn() }) as any;
  const send = (s: string) => stdin.emit('data', Buffer.from(s, 'utf8'));
  /** Asterisks echoed, ignoring the prompt and the trailing newline. */
  const stars = () => (out.match(/\*/g) ?? []).length;

  it('echoes one asterisk per character instead of the key itself', async () => {
    const p = __testing.askSecretInput(rl(), 'key: ');
    send('sk-abc123');
    send('\r');
    await expect(p).resolves.toBe('sk-abc123');
    expect(stars()).toBe(9);
    expect(out).not.toContain('sk-abc123');
  });

  it('masks a bulk paste — the whole key arrives in one chunk', async () => {
    const key = 'a'.repeat(108);
    const p = __testing.askSecretInput(rl(), 'key: ');
    send(key);
    send('\r');
    await expect(p).resolves.toBe(key);
    expect(stars()).toBe(108);
  });

  it('strips bracketed-paste markers instead of storing them in the key', async () => {
    const p = __testing.askSecretInput(rl(), 'key: ');
    send('\x1b[200~ark-secret\x1b[201~');
    send('\r');
    await expect(p).resolves.toBe('ark-secret');
    expect(stars()).toBe(10);
  });

  it('backspace removes a character from both the buffer and the display', async () => {
    const p = __testing.askSecretInput(rl(), 'key: ');
    send('abcd');
    send('\x7f');
    send('\r');
    await expect(p).resolves.toBe('abc');
    expect(out).toContain('\b \b');
  });

  it('Ctrl-C cancels and yields nothing', async () => {
    const p = __testing.askSecretInput(rl(), 'key: ');
    send('secret');
    send('\x03');
    await expect(p).resolves.toBe('');
  });

  it('restores the previous raw-mode state and lets readline resume', async () => {
    const iface = rl();
    const p = __testing.askSecretInput(iface, 'key: ');
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(iface.pause).toHaveBeenCalled();
    send('k\r');
    await p;
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(iface.resume).toHaveBeenCalled();
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('trims surrounding whitespace a paste often carries', async () => {
    const p = __testing.askSecretInput(rl(), 'key: ');
    send('  sk-xyz  \r');
    await expect(p).resolves.toBe('sk-xyz');
  });
});

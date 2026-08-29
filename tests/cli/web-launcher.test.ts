import { describe, it, expect } from 'vitest';
import { extractServerUrl, openCommand } from '../../src/cli/web-launcher.js';
import { handleWebCommand } from '../../src/cli/repl-web-command.js';
import type { ChildProcess } from 'child_process';

/**
 * `webaura` and `:auraweb` both start the same server and both need its URL.
 * The URL is parsed out of the server's own output rather than composed here,
 * because the server picks the port and mints the token — anything rebuilt on
 * this side would be a guess that stops matching the moment either changes.
 */

describe('finding the URL in the server banner', () => {
  it('picks it out of the real banner line', () => {
    const banner = '  Ready → http://127.0.0.1:7337/?token=abc123def  (Ctrl+C to stop)';
    expect(extractServerUrl(banner)).toBe('http://127.0.0.1:7337/?token=abc123def');
  });

  it('takes the token with it — a URL without one cannot log in', () => {
    const url = extractServerUrl('URL : http://127.0.0.1:9000/?token=deadbeef');
    expect(url).toContain('?token=deadbeef');
  });

  it('returns null rather than a half-URL while the server is still starting', () => {
    expect(extractServerUrl('  Aura — web client')).toBeNull();
    expect(extractServerUrl('http://127.0.0.1:7337/')).toBeNull();
  });
});

describe('opening a browser', () => {
  it('knows the command for each desktop platform', () => {
    expect(openCommand('darwin')?.cmd).toBe('open');
    expect(openCommand('linux')?.cmd).toBe('xdg-open');
    expect(openCommand('win32')?.cmd).toBe('cmd');
  });

  it('returns nothing where there is no browser to open', () => {
    // A headless or exotic platform prints the URL instead. Spawning a command
    // that does not exist would look like the server failed to start.
    expect(openCommand('aix')).toBeNull();
  });
});

describe(':auraweb', () => {
  const ctx = () => {
    const printed: string[] = [];
    const opened: string[] = [];
    const launched: unknown[] = [];
    const fakeChild = { killed: false, on: () => fakeChild } as unknown as ChildProcess;
    return {
      printed, opened, launched, fakeChild,
      c: {
        print: (l: string) => printed.push(l),
        server: { child: null as ChildProcess | null, url: null as string | null },
        open: (u: string) => opened.push(u),
        launch: (opts: unknown) => { launched.push(opts); return fakeChild; },
      },
    };
  };

  it('answers to the name the binary has, and the name the command has', () => {
    // The global binary is `webaura` and the command is `:auraweb`. Nobody
    // will remember which is which at the moment they need it, so both work
    // rather than one of them saying "unknown command" to somebody who typed
    // the other name for the same thing.
    for (const trigger of [':auraweb', ':webaura', ':web', '/auraweb']) {
      const t = ctx();
      expect(handleWebCommand(trigger, t.c), trigger).not.toBeNull();
    }
  });

  it('leaves anything else alone', () => {
    const t = ctx();
    expect(handleWebCommand('what is the web client?', t.c)).toBeNull();
    expect(handleWebCommand(':webhook', t.c)).toBeNull();
    expect(t.printed).toEqual([]);
  });

  it('starts the server and opens the URL it reports', () => {
    const t = ctx();
    handleWebCommand(':auraweb', t.c);
    expect(t.launched).toHaveLength(1);
    // Drive the callback the launcher would fire once the server announces.
    (t.launched[0] as { onUrl: (u: string) => void }).onUrl('http://127.0.0.1:7337/?token=x');
    expect(t.opened).toEqual(['http://127.0.0.1:7337/?token=x']);
    expect(t.printed.join(' ')).toContain('http://127.0.0.1:7337/?token=x');
  });

  it('forwards its arguments to the server', () => {
    const t = ctx();
    handleWebCommand(':auraweb --port 8080', t.c);
    expect((t.launched[0] as { args: string[] }).args).toEqual(['--port', '8080']);
  });

  it('does not start a second server on top of the first', () => {
    // The port is already taken, so a second launch would fail and read as
    // "the command is broken". Report the running one and re-open it instead.
    const t = ctx();
    t.c.server.child = t.fakeChild;
    t.c.server.url = 'http://127.0.0.1:7337/?token=live';
    handleWebCommand(':auraweb', t.c);
    expect(t.launched).toHaveLength(0);
    expect(t.opened).toEqual(['http://127.0.0.1:7337/?token=live']);
    expect(t.printed.join(' ')).toContain('already running');
  });

  it('says it is starting when asked again before the URL arrives', () => {
    const t = ctx();
    t.c.server.child = t.fakeChild;
    handleWebCommand(':auraweb', t.c);
    expect(t.opened).toEqual([]);
    expect(t.printed.join(' ')).toContain('starting');
  });

  it('keeps the server output out of the REPL', () => {
    // The REPL owns the terminal; the server's banner would garble it. The
    // one URL line is all the user needs.
    const t = ctx();
    handleWebCommand(':auraweb', t.c);
    const opts = t.launched[0] as { write: (c: string) => void };
    expect(() => opts.write('  Ready → ...')).not.toThrow();
    expect(t.printed.some((l) => l.includes('Ready →'))).toBe(false);
  });
});

/**
 * Starting the web client from somewhere that is already running Aura.
 *
 * Both entry points here — the `webaura` binary and the REPL's `:auraweb` —
 * spawn `aura serve` as a child rather than calling into it. That is not
 * laziness: `cli/index.ts` self-executes on import (it reads real credentials
 * into `process.env` at module scope), so importing the serve path would run
 * the whole CLI a second time inside the process that is already the CLI.
 * A child process is the only way to reuse it without that.
 *
 * The URL is parsed back out of the child's own output rather than
 * reconstructed here. The server picks the port and mints the session token,
 * so anything this module composed itself would be a guess that silently stops
 * matching the moment either changes.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

/** Matches the line `aura serve` prints: an http URL carrying its token. */
const URL_RE = /(https?:\/\/\S+?\/\?token=[A-Za-z0-9]+)/;

export function extractServerUrl(text: string): string | null {
  return URL_RE.exec(text)?.[1] ?? null;
}

/**
 * The command that opens a URL in the user's browser, per platform.
 *
 * Returns null where there is nothing sensible to run, so the caller prints
 * the URL instead of spawning a process that will not exist. A failed
 * `xdg-open` on a headless box should not look like the server failed.
 */
export function openCommand(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [] };
  return null;
}

/** Open a URL in the browser, best-effort. Never throws, never blocks. */
export function openInBrowser(url: string): void {
  const open = openCommand();
  if (!open) return;
  try {
    // detached + unref so closing Aura does not close the browser, and
    // ignored stdio so a chatty xdg-open cannot garble the terminal.
    spawn(open.cmd, [...open.args, url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the URL is printed regardless; opening is a convenience */ }
}

/** Path to this installation's `aura` entry point. */
export function auraEntry(): string {
  // Resolved from this file rather than from PATH: a dev checkout and a global
  // install must each start *their own* server, not whichever one happens to
  // be first on PATH.
  return path.resolve(__dirname, 'index.js');
}

export interface LaunchOptions {
  /** Extra arguments forwarded to `aura serve`, e.g. ['--port', '8080']. */
  args?: string[];
  /** Open the browser once the URL appears. */
  open?: boolean;
  /** Called with the URL the moment the server announces it. */
  onUrl?: (url: string) => void;
  /** Where the child's output goes. Defaults to this process's stdout. */
  write?: (chunk: string) => void;
}

/**
 * Spawn `aura serve` and watch its output for the URL.
 *
 * The child's output is piped rather than inherited so the URL can be seen,
 * and then written straight through — the user still gets the server's own
 * banner, unchanged and in real time.
 */
export function launchWebServer(opts: LaunchOptions = {}): ChildProcess {
  const write = opts.write ?? ((c: string) => process.stdout.write(c));
  const child = spawn(process.execPath, [auraEntry(), 'serve', ...(opts.args ?? [])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let found = false;
  const scan = (chunk: Buffer) => {
    const text = chunk.toString();
    write(text);
    if (found) return;
    const url = extractServerUrl(text);
    if (!url) return;
    found = true;
    opts.onUrl?.(url);
    if (opts.open) openInBrowser(url);
  };

  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);
  return child;
}

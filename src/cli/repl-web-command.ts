/**
 * The REPL's `:auraweb` — bring up the web client from inside the TUI.
 *
 * In its own module for the same reason the other repl-*-commands are:
 * cli/index.ts self-executes on import (it reads real credentials into
 * process.env at module scope), so a branch that lives there cannot be covered
 * by a test — which is how a command ends up advertised and unimplemented at
 * once with nothing going red.
 *
 * The server runs as a child of the REPL, deliberately. Detaching it would
 * leave a port and a session token alive after Aura exits, with no obvious way
 * to find or stop it; as a child it dies with the terminal that started it,
 * and `:auraweb` a second time reports the running one rather than racing it
 * for the port.
 */

import type { ChildProcess } from 'child_process';
import { launchWebServer, openInBrowser } from './web-launcher.js';

export interface WebCommandCtx {
  /** Prints a line to the REPL. */
  print: (line: string) => void;
  /** The running server, if `:auraweb` already started one. */
  server: { child: ChildProcess | null; url: string | null };
  /** Open a browser at the URL. Injected so tests do not spawn one. */
  open?: (url: string) => void;
  /** Spawn the server. Injected for the same reason. */
  launch?: typeof launchWebServer;
}

export interface WebCommandResult {
  handled: true;
}

const TRIGGERS = [':auraweb', '/auraweb', ':webaura', '/webaura', ':web', '/web'];

/**
 * Handle `:auraweb`, or return null when the input is not ours.
 *
 * `:webaura` and `:web` are accepted too. The global binary is `webaura` and
 * the command is `:auraweb`, which is a difference nobody will remember at the
 * moment they need it — so both work, rather than one of them printing
 * "unknown command" at somebody who typed the other name of the same thing.
 */
export function handleWebCommand(input: string, c: WebCommandCtx): WebCommandResult | null {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const matched = TRIGGERS.find((t) => lower === t || lower.startsWith(`${t} `));
  if (!matched) return null;

  const args = trimmed.slice(matched.length).trim().split(/\s+/).filter(Boolean);
  const open = c.open ?? openInBrowser;

  // Already up: say where, and open it again. Starting a second server would
  // fail on the port and read as "the command is broken".
  if (c.server.child && !c.server.child.killed) {
    if (c.server.url) {
      c.print(`  Web client already running — ${c.server.url}`);
      open(c.server.url);
    } else {
      c.print('  Web client is starting…');
    }
    return { handled: true };
  }

  c.print('  Starting the web client…');
  const launch = c.launch ?? launchWebServer;
  const child = launch({
    args,
    // The REPL owns the terminal, so the server's banner must not be written
    // into it — the URL line below is the only output the user needs.
    write: () => {},
    onUrl: (url) => {
      c.server.url = url;
      c.print(`  Web client ready — ${url}`);
      open(url);
    },
  });

  c.server.child = child;
  child.on('exit', () => {
    c.server.child = null;
    c.server.url = null;
  });

  return { handled: true };
}

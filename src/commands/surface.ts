/**
 * Where a command's output goes.
 *
 * Commands used to live inside the TUI's REPL loop and print with
 * `console.log`. That was fine while the terminal was the only surface, and
 * wrong the moment the web client shipped: `/api/commands` advertises the same
 * command set to the browser, but the browser had no way to *run* any of it —
 * `web/src/lib/commands.ts` ran fourteen of them locally and answered the rest
 * with "terminal only". Fifty-two commands were listed and not wired.
 *
 * A surface is the seam that fixes that. The command implementations write
 * through `emit()` instead of `console.log`, and each caller installs the
 * surface that knows where its output belongs: the TUI writes into its scroll
 * region, the engine's `command.run` collects lines and ships them back to
 * whichever client asked.
 *
 * Why not simply patch `process.stdout.write` around the call, the way the TUI
 * already does for library output? Because the engine serves several clients
 * at once. A turn streaming to one socket writes to the same stdout, so a
 * capture window would fold one client's output into another client's command
 * result — on a server that is deliberately reachable from phones on the LAN.
 * An explicit sink cannot do that.
 */

/** Ambient text style. The terminal renders these with colour; a remote client
 *  gets the tag and decides for itself. */
export type EmitLevel = 'plain' | 'ok' | 'warn' | 'error';

export interface CommandSurface {
  /** 'terminal' can open interactive selectors and read keys; 'remote' cannot. */
  kind: 'terminal' | 'remote';
  /** One block of already-formatted text. May contain newlines. */
  write(text: string, level?: EmitLevel): void;
  /** Redraw the persistent status line, where the surface has one. */
  setStatusLine?(text: string): void;
}

/**
 * The surface the command currently running should write to.
 *
 * Module-level rather than threaded through every call because the command
 * bodies print from deep inside helpers that have no context parameter, and
 * because only one command runs at a time per process — `withSurface` is the
 * only way to set it, and it restores the previous one on the way out, so
 * nesting (a command that runs another) behaves.
 */
let active: CommandSurface | null = null;

/** A surface that throws away output. Used when nothing is listening. */
const SILENT: CommandSurface = { kind: 'remote', write: () => {} };

/**
 * The terminal surface. Deliberately `console.log` and not a direct
 * `process.stdout.write`: the TUI patches stdout and routes it into the scroll
 * region either way, so the two are equivalent on screen — but the command
 * tests assert against a console spy, and printing underneath it would make a
 * passing test stop proving that the command said anything.
 */
export const TERMINAL_SURFACE: CommandSurface = {
  kind: 'terminal',
  // eslint-disable-next-line no-console
  write: (text) => { console.log(text); },
};

export function currentSurface(): CommandSurface {
  return active ?? TERMINAL_SURFACE;
}

/** Print a block of text to the surface running this command. */
export function emit(text: unknown, level: EmitLevel = 'plain'): void {
  currentSurface().write(typeof text === 'string' ? text : String(text), level);
}

/** Run `fn` with `surface` installed, restoring whatever was there before. */
export async function withSurface<T>(surface: CommandSurface, fn: () => Promise<T>): Promise<T> {
  const previous = active;
  active = surface;
  try { return await fn(); }
  finally { active = previous; }
}

/**
 * A surface that collects everything written to it — what `command.run` hands
 * back to a remote client, and what tests assert against.
 */
export function collectingSurface(): CommandSurface & { lines(): string[]; text(): string } {
  const collected: string[] = [];
  return {
    kind: 'remote',
    write: (text) => { collected.push(text.replace(/\n+$/, '')); },
    lines: () => collected.slice(),
    text: () => collected.join('\n'),
  };
}

export { SILENT as SILENT_SURFACE };

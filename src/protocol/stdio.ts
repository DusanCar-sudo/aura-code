import * as readline from 'readline';
import { ProtocolHandler } from './handler.js';
import type { Frame } from './types.js';

/**
 * stdio transport — newline-delimited JSON, one frame per line.
 *
 * This is what `aura sidecar` runs. The client (Tauri) spawns the engine as
 * a child process and speaks over the pipes: no TCP listener, no port, no
 * auth surface, and the OS process boundary is the trust boundary.
 *
 * stdout carries protocol frames and NOTHING else. Anything in the engine
 * that writes to stdout would corrupt the stream, so this module redirects
 * `console.log` to stderr for the lifetime of the process. Diagnostics stay
 * visible to whoever is reading stderr; they just never land in the frames.
 */

export interface SidecarOptions {
  defaultModel: string;
  defaultApiKey?: string;
  defaultBaseUrl?: string;
  defaultProjectRoot: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Serialise one frame as a single line. Rejects embedded newlines by construction. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

/**
 * Parse one line into a Frame. Returns null for blank lines and for anything
 * that is not a JSON object with a valid `kind` — the caller reports those as
 * bad_frame rather than throwing, so one malformed line cannot kill the
 * session.
 */
export function decodeFrame(line: string): Frame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind !== 'req' && kind !== 'res' && kind !== 'evt') return null;
  return parsed as Frame;
}

/**
 * Run the sidecar until stdin closes. Resolves when the input stream ends,
 * so the caller can exit cleanly.
 */
export function runSidecar(opts: SidecarOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  // Protect the frame stream from stray library logging. Restored on exit
  // only in the sense that the process is ending; the sidecar owns stdout.
  const realLog = console.log;
  console.log = (...args: unknown[]) => { console.error(...args); };

  const send = (frame: Frame): void => {
    output.write(encodeFrame(frame));
  };

  const handler = new ProtocolHandler({
    defaultModel: opts.defaultModel,
    defaultApiKey: opts.defaultApiKey,
    defaultBaseUrl: opts.defaultBaseUrl,
    defaultProjectRoot: opts.defaultProjectRoot,
    send,
  });

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  // Frames are dispatched as they arrive, NOT serialised behind one another.
  //
  // Serialising here deadlocks the protocol: handler.turnSend() only settles
  // when the turn is over, so an approval response queued behind the very
  // turn that is waiting for it can never be delivered — the turn blocks
  // until the approval times out and denies. Observed exactly that: an
  // `allow` was sent and the tool still came back "denied by user".
  //
  // Dispatching immediately is safe. handle() catches its own errors, JS
  // runs each frame's synchronous prologue to completion before any await,
  // and single-flight-per-session is enforced in the handler by
  // `session_busy` rather than by transport-level queueing.
  rl.on('line', (line: string) => {
    const frame = decodeFrame(line);
    if (!frame) {
      if (line.trim()) {
        send({
          kind: 'res', id: '', ok: false,
          error: { code: 'bad_frame', message: 'Each line must be one JSON object with kind req|res|evt.' },
        });
      }
      return;
    }
    void handler.handle(frame);
  });

  handler.ready();

  return new Promise<void>(resolve => {
    rl.on('close', () => {
      handler.dispose();
      console.log = realLog;
      resolve();
    });
  });
}

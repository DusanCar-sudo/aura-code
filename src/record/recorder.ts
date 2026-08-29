/**
 * Driving the evdev recorder process.
 *
 * The Python half reads the devices; this half owns its lifetime and collects
 * what it emits. Split that way because the interesting logic — turning
 * press/release pairs into "Ctrl+C" — lives in compile.ts where it can be
 * tested without a keyboard, and this file has nothing in it worth testing
 * beyond "the process started and then it stopped".
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { RawEvent } from './types.js';

/** The recorder script, in dist/ after a build and in src/ during development. */
export function recorderScriptPath(): string {
  const built = path.join(__dirname, '..', 'tools', 'screen', 'aura_record.py');
  if (fs.existsSync(built)) return built;
  return path.join(__dirname, '..', '..', 'src', 'tools', 'screen', 'aura_record.py');
}

export interface RecorderHandle {
  /** Resolves once the recorder is listening, or rejects with why it is not. */
  ready: Promise<{ devices: number }>;
  /** Stop and return everything captured. */
  stop(): Promise<RawEvent[]>;
  /** Events so far — read live so a caller can show a running count. */
  events(): RawEvent[];
  /** Screenshot paths, in click order. Only filled once `stop` has resolved. */
  shots(): string[];
}

export interface RecorderOptions {
  python?: string;
  /**
   * Capture the screen at a click. Called on the press, not the release, so
   * the frame is as close as possible to what the operator was looking at when
   * they decided to click.
   */
  onClick?: (index: number) => Promise<string | null>;
}

/**
 * Start recording.
 *
 * Never throws synchronously; a missing python3 or a missing evdev surfaces
 * through `ready`, because the caller wants to print that as a message rather
 * than handle an exception at the point of a keystroke.
 */
export function startRecorder(opts: RecorderOptions = {}): RecorderHandle {
  const python = opts.python ?? process.env.AURA_PYTHON ?? 'python3';
  const collected: RawEvent[] = [];
  // Capture is slower than reading an event, so the shots are started as the
  // clicks arrive and collected at the end. Awaiting one inside the stdout
  // handler would stall the reader and lose whatever was typed meanwhile.
  const pending: Promise<string | null>[] = [];
  let taken: string[] = [];
  let clicks = 0;
  let child: ChildProcess | null = null;
  // Captured out of the executor rather than declared as `let x = null` above
  // it: TypeScript narrows those to `never` at every later use, because it
  // cannot see that the executor runs synchronously.
  let settle!: (v: { devices: number }) => void;
  let fail!: (e: Error) => void;

  const ready = new Promise<{ devices: number }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  try {
    child = spawn(python, [recorderScriptPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    fail(e instanceof Error ? e : new Error(String(e)));
    return { ready, stop: async () => collected, events: () => collected, shots: () => [] };
  }

  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    // Line-delimited JSON: hold the trailing partial line until it completes,
    // or a long recording drops an event every time a write is split.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.error) { fail(new Error(String(msg.error))); continue; }
      if (msg.ready) { settle({ devices: Number(msg.devices ?? 0) }); continue; }
      if (msg.done) continue;
      if (typeof msg.t === 'number' && typeof msg.kind === 'string') {
        const event = msg as unknown as RawEvent;
        collected.push(event);
        if (opts.onClick && event.kind === 'button' && event.value === 1) {
          pending.push(opts.onClick(clicks++));
        }
      }
    }
  });

  // A recorder that dies before saying "ready" has to reject, or the caller
  // waits for ever on a process that is already gone.
  child.on('exit', () => fail(new Error('The recorder stopped before it was ready.')));
  child.on('error', (e) => fail(e));

  return {
    ready,
    events: () => collected,
    shots: () => taken,
    async stop() {
      if (!child || child.exitCode !== null) return collected;
      // A newline is the recorder's clean stop: it finishes the events already
      // read before exiting, where a signal would cut the tail off.
      try { child.stdin?.write('\n'); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        child?.once('exit', done);
        setTimeout(() => { child?.kill('SIGTERM'); resolve(); }, 2000);
      });
      // Settle the captures that were still in flight when recording stopped —
      // the last click's shot is usually one of them, and it is the one most
      // likely to matter.
      const results = await Promise.all(pending);
      taken = results.filter((p): p is string => typeof p === 'string');
      return collected;
    },
  };
}

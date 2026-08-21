/**
 * Node-side owner of the Python screen sidecar (screen/aura_screen.py).
 *
 * One long-lived child process per Aura run, because both halves of computer
 * use hold state that cannot survive a one-shot call: the ScreenCast session
 * dies with the D-Bus connection that created it, and the uinput device
 * disappears when its descriptor closes. Restarting per action would also mean
 * a portal handshake and a ~1.2s udev settle before every single click.
 *
 * Protocol: one JSON request per line on stdin, one JSON reply per line on
 * stdout. Requests are serialised through a queue rather than multiplexed —
 * there is no request id in the protocol, and adding one would buy nothing:
 * the actions are physical and inherently ordered. Two clicks cannot overlap.
 *
 * stderr is kept separate and surfaced only in errors. The portal and GStreamer
 * both write chatter there on a perfectly good run, so treating it as failure
 * output would make every session look broken.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SidecarReply {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

/** Actions can wait on a human (the portal consent dialog on first run) or on
 *  a slow first frame, so the default is generous. Individual calls override. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Where aura_screen.py lives. Resolved relative to this module so it works
 *  from dist/ and from ts-node, and checked explicitly: the script is copied
 *  into dist/ by a build step, and a missing file must say so rather than
 *  surface as a Python ImportError or an ENOENT stack. */
export function sidecarScriptPath(): string {
  // CommonJS output, so __dirname is always defined — it resolves to
  // dist/tools/screen at runtime and src/tools/screen under ts-node.
  return path.join(__dirname, 'aura_screen.py');
}

export class ScreenSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';
  private queue: Array<{
    resolve: (r: SidecarReply) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private exited: string | null = null;

  /** Screen size reported by init, once started. */
  width = 0;
  height = 0;

  constructor(private python = process.env.AURA_PYTHON ?? 'python3') {}

  get running(): boolean { return this.proc !== null && this.exited === null; }

  /** Spawn the child and run `init` (portal handshake + uinput device). */
  async start(): Promise<void> {
    if (this.running) return;

    const script = sidecarScriptPath();
    if (!fs.existsSync(script)) {
      throw new Error(
        `Screen sidecar not found at ${script}. This is a packaging fault, not a `
        + 'configuration one — reinstall aura-code, or run from a source checkout.',
      );
    }

    this.exited = null;
    this.buffer = '';
    this.stderr = '';
    const proc = spawn(this.python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      // Bounded: a chatty run must not grow this without limit for the whole
      // session, but the tail is what an error message needs.
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    proc.on('error', (e) => this.die(`could not start ${this.python}: ${e.message}`));
    proc.on('exit', (code, signal) =>
      this.die(`sidecar exited (${signal ?? `code ${code}`})${this.stderr ? `: ${this.stderr.trim().slice(-500)}` : ''}`));

    const r = await this.send({ cmd: 'init' });
    if (!r.ok) throw new Error(`screen init failed: ${r.error ?? 'unknown error'}`);
    this.width = Number(r.width) || 0;
    this.height = Number(r.height) || 0;
    if (this.width <= 0 || this.height <= 0) {
      throw new Error(`screen init reported no usable screen size (${this.width}x${this.height})`);
    }
  }

  /** Send one command and await its reply. */
  send(req: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SidecarReply> {
    const proc = this.proc;
    if (!proc || this.exited) {
      return Promise.reject(new Error(this.exited ?? 'screen sidecar is not running'));
    }
    return new Promise<SidecarReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the entry so a late reply is not matched to the next request —
        // replies are positional, so one orphan would shift every later answer.
        const i = this.queue.findIndex(q => q.timer === timer);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(`screen sidecar timed out after ${timeoutMs}ms on ${String(req.cmd)}`));
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer });
      proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  /** Ask the child to exit, then make sure it did. */
  async stop(): Promise<void> {
    if (!this.running) { this.proc = null; return; }
    try { await this.send({ cmd: 'close' }, 5_000); } catch { /* killing anyway */ }
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      // The child holds /dev/uinput and a portal session; if SIGTERM is ignored
      // those leak for the life of the login session.
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 2_000).unref?.();
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const waiter = this.queue.shift();
      if (!waiter) continue;              // unsolicited line; nothing to resolve
      clearTimeout(waiter.timer);
      try {
        waiter.resolve(JSON.parse(line) as SidecarReply);
      } catch {
        waiter.reject(new Error(`screen sidecar sent malformed JSON: ${line.slice(0, 200)}`));
      }
    }
  }

  /** Fail every in-flight request. Without this a crashed child leaves the
   *  agent waiting on a promise that can never settle. */
  private die(reason: string): void {
    if (this.exited) return;
    this.exited = reason;
    this.proc = null;
    const waiting = this.queue.splice(0);
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
  }
}

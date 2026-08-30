/**
 * Protocol client — the browser half of what src/protocol/ already speaks.
 *
 * `aura serve` runs a ProtocolHandler over the same WebSocket that serves this
 * page, using the identical frame schema as `aura sidecar`. So this file is a
 * transport and a promise table, nothing more: no business logic lives here,
 * because the engine already owns it.
 *
 * Frames: {kind:'req'|'res'|'evt'}. We send `req`, receive `res` for our own
 * requests and `evt` for everything the engine volunteers. The engine can also
 * send a `req` of its own — `approval.request` — which we must answer with a
 * `res`, so this is a bidirectional peer, not a client.
 */

export type FrameKind = 'req' | 'res' | 'evt';

export interface ReqFrame { kind: 'req'; id: string; method: string; params?: unknown }
export interface ResFrame {
  kind: 'res'; id: string; ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface EvtFrame { kind: 'evt'; method: string; params?: unknown }
export type Frame = ReqFrame | ResFrame | EvtFrame;

/** Method names, mirroring src/protocol/types.ts `M`. */
export const M = {
  sessionCreate: 'session.create',
  sessionDestroy: 'session.destroy',
  sessionRename: 'session.rename',
  sessionList: 'session.list',
  sessionHistory: 'session.history',
  sessionState: 'session.state',
  turnSend: 'turn.send',
  turnCancel: 'turn.cancel',
  toolsList: 'tools.list',
  usageGet: 'usage.get',
  boardGet: 'board.get',
  boardAdd: 'board.add',
  boardUpdate: 'board.update',
  boardRemove: 'board.remove',
  boardRun: 'board.run',
  approvalRequest: 'approval.request',
  engineReady: 'engine.ready',
  turnStarted: 'turn.started',
  turnDelta: 'turn.delta',
  turnToolCall: 'turn.tool_call',
  turnToolResult: 'turn.tool_result',
  turnToolBlocked: 'turn.tool_blocked',
  turnCompleted: 'turn.completed',
  turnError: 'turn.error',
  boardChanged: 'board.changed',
  log: 'log',
} as const;

export type ConnectionState = 'connecting' | 'open' | 'closed';

type EventHandler = (method: string, params: unknown) => void;
/** Returns the value to answer the engine's request with. */
type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface ProtocolClientOptions {
  url?: string;
  token?: string;
  onEvent: EventHandler;
  onRequest?: RequestHandler;
  onState?: (state: ConnectionState) => void;
}

import { getAuthToken, getAuthTokenSync, refreshAuthToken } from './auth';

export class ProtocolClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** Queued while the socket is down, flushed on open — a click during a
   *  reconnect should not be silently dropped. */
  private outbox: string[] = [];
  private reconnectMs = 500;
  private closedByUs = false;
  /** Did this attempt ever reach `open`? */
  private everOpened = false;

  constructor(private readonly opts: ProtocolClientOptions) {}

  async connect(): Promise<void> {
    this.closedByUs = false;
    this.everOpened = false;
    let tok = this.opts.token;
    if (!tok) {
      tok = await getAuthToken();
    }
    const url = this.opts.url ?? defaultSocketUrl(tok);
    this.opts.onState?.('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.everOpened = true;
      this.reconnectMs = 500;
      this.opts.onState?.('open');
      for (const frame of this.outbox.splice(0)) ws.send(frame);
    };

    ws.onmessage = (ev) => {
      let frame: Frame;
      try { frame = JSON.parse(String(ev.data)) as Frame; } catch { return; }
      void this.dispatch(frame);
    };

    ws.onclose = () => {
      this.opts.onState?.('closed');
      // Every in-flight request is now unanswerable; failing them is honest,
      // leaving them hanging is not.
      for (const [, p] of this.pending) p.reject(new Error('connection closed'));
      this.pending.clear();
      if (!this.closedByUs) this.scheduleReconnect(!this.everOpened);
    };

    ws.onerror = () => { /* onclose does the work; this keeps it off the console */ };
  }

  private async dispatch(frame: Frame): Promise<void> {
    if (frame.kind === 'res') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.result);
      else entry.reject(new Error(frame.error?.message ?? frame.error?.code ?? 'request failed'));
      return;
    }
    if (frame.kind === 'evt') {
      this.opts.onEvent(frame.method, frame.params);
      return;
    }
    // The engine asking US something — approval.request. Answering is
    // mandatory: an unanswered approval stalls the turn that raised it.
    if (frame.kind === 'req') {
      let result: unknown;
      let ok = true;
      try {
        result = await this.opts.onRequest?.(frame.method, frame.params);
      } catch (e) {
        ok = false;
        result = { message: String(e) };
      }
      this.raw({
        kind: 'res', id: frame.id, ok,
        ...(ok ? { result } : { error: { code: 'internal', message: String(result) } }),
      } as ResFrame);
    }
  }

  /**
   * @param rejected the socket closed without ever opening, which for this
   *   server means the handshake was refused — almost always a stale token.
   *   Re-resolving it from source is the only thing that can change the
   *   outcome, so retrying with the same one is just a slower failure.
   */
  private scheduleReconnect(rejected = false): void {
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 10_000);
    setTimeout(() => {
      if (this.closedByUs) return;
      void (async () => {
        if (rejected && !this.opts.token) await refreshAuthToken();
        await this.connect();
      })();
    }, delay);
  }

  private raw(frame: Frame): void {
    const line = JSON.stringify(frame);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(line);
    else this.outbox.push(line);
  }

  /** Send a request and await its response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `w${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.raw({ kind: 'req', id, method, params });
    });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * The socket lives on the same origin that served the page, or on 127.0.0.1:7337
 * when running in desktop/Tauri environments.
 */
export function defaultSocketUrl(token?: string): string {
  const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = isTauri || (typeof location !== 'undefined' && (location.port === '5173' || !location.port))
    ? '127.0.0.1:7337'
    : (typeof location !== 'undefined' && location.host ? location.host : '127.0.0.1:7337');
  const t = token || getAuthTokenSync();
  return `${proto}//${host}/${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}

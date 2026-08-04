import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProtocolHandler } from '../../src/protocol/handler.js';
import { encodeFrame, decodeFrame } from '../../src/protocol/stdio.js';
import { M, type Frame } from '../../src/protocol/types.js';
import { confirm, setConfirmHandler } from '../../src/safety/permissions.js';

/**
 * These drive the handler directly with frames, so they cover protocol
 * semantics without a provider. Anything needing a real turn is covered by
 * scripts/protocol-test-client.mjs against a live model.
 */

function collector() {
  const frames: Frame[] = [];
  return {
    frames,
    send: (f: Frame) => { frames.push(f); },
    /** The response to request `id`. */
    res: (id: string) => frames.find(f => f.kind === 'res' && f.id === id) as
      Extract<Frame, { kind: 'res' }> | undefined,
    evts: (method: string) => frames.filter(f => f.kind === 'evt' && f.method === method),
    reqs: (method: string) => frames.filter(f => f.kind === 'req' && f.method === method) as
      Extract<Frame, { kind: 'req' }>[],
  };
}

let n = 0;
const req = (method: string, params?: Record<string, unknown>): Frame =>
  ({ kind: 'req', id: `t${++n}`, method, params });

describe('protocol framing', () => {
  it('round-trips a frame through one line', () => {
    const f: Frame = { kind: 'req', id: '1', method: M.toolsList, params: {} };
    const line = encodeFrame(f);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(decodeFrame(line)).toEqual(f);
  });

  it('rejects non-frames rather than throwing', () => {
    expect(decodeFrame('')).toBeNull();
    expect(decodeFrame('   ')).toBeNull();
    expect(decodeFrame('not json')).toBeNull();
    expect(decodeFrame('"a string"')).toBeNull();
    expect(decodeFrame('{"no":"kind"}')).toBeNull();
    expect(decodeFrame('{"kind":"nonsense"}')).toBeNull();
  });

  it('escapes newlines inside payloads so one frame stays one line', () => {
    const f: Frame = { kind: 'evt', method: M.turnDelta, params: { text: 'a\nb\nc' } };
    expect(encodeFrame(f).trimEnd().split('\n')).toHaveLength(1);
    expect((decodeFrame(encodeFrame(f)) as { params: { text: string } }).params.text).toBe('a\nb\nc');
  });
});

describe('ProtocolHandler', () => {
  let tmp: string;
  let c: ReturnType<typeof collector>;
  let h: ProtocolHandler;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-proto-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    c = collector();
    h = new ProtocolHandler({
      defaultModel: 'deepseek/deepseek-v4-flash',
      defaultProjectRoot: tmp,
      send: c.send,
      approvalTimeoutMs: 200,
    });
  });
  afterEach(() => {
    h.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    setConfirmHandler(null);
  });

  const create = async (params: Record<string, unknown> = {}) => {
    const f = req(M.sessionCreate, { projectRoot: tmp, ...params });
    await h.handle(f);
    const r = c.res((f as { id: string }).id);
    return (r as { ok: true; result: { sessionId: string } }).result.sessionId;
  };

  it('announces readiness with a protocol version', () => {
    h.ready();
    const [evt] = c.evts(M.engineReady);
    expect(evt).toBeDefined();
    expect((evt as { params: { protocolVersion: number } }).params.protocolVersion).toBe(1);
  });

  it('creates a session scoped to the given project root', async () => {
    const f = req(M.sessionCreate, { projectRoot: tmp, name: 'demo' });
    await h.handle(f);
    const r = c.res('t' + n);
    expect(r?.ok).toBe(true);
    const result = (r as { ok: true; result: Record<string, unknown> }).result;
    expect(result.projectRoot).toBe(tmp);
    expect(result.name).toBe('demo');
    expect(typeof result.sessionId).toBe('string');
  });

  it('lists and destroys sessions', async () => {
    const id = await create({ name: 'one' });
    await h.handle(req(M.sessionList));
    const list = (c.res('t' + n) as { ok: true; result: { sessions: unknown[] } }).result.sessions;
    expect(list).toHaveLength(1);

    await h.handle(req(M.sessionDestroy, { sessionId: id }));
    expect((c.res('t' + n) as { ok: true; result: { destroyed: boolean } }).result.destroyed).toBe(true);

    await h.handle(req(M.sessionList));
    expect((c.res('t' + n) as { ok: true; result: { sessions: unknown[] } }).result.sessions).toHaveLength(0);
  });

  it('reports per-session usage against its own ceiling', async () => {
    const id = await create({ maxInputTokens: 12_345 });
    await h.handle(req(M.usageGet, { sessionId: id }));
    const u = (c.res('t' + n) as { ok: true; result: Record<string, unknown> }).result;
    expect(u).toEqual({
      inputTokensUsed: 0, maxInputTokens: 12_345, turnsUsed: 0, exhausted: false,
    });
  });

  it('gives each session an independent budget', async () => {
    const a = await create({ maxInputTokens: 100 });
    const b = await create({ maxInputTokens: 999 });
    await h.handle(req(M.usageGet, { sessionId: a }));
    const ua = (c.res('t' + n) as { ok: true; result: { maxInputTokens: number } }).result;
    await h.handle(req(M.usageGet, { sessionId: b }));
    const ub = (c.res('t' + n) as { ok: true; result: { maxInputTokens: number } }).result;
    expect(ua.maxInputTokens).toBe(100);
    expect(ub.maxInputTokens).toBe(999);
  });

  it('exposes the engine tool list', async () => {
    await h.handle(req(M.toolsList));
    const tools = (c.res('t' + n) as { ok: true; result: { tools: { name: string }[] } }).result.tools;
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.map(t => t.name)).toContain('read_file');
    expect(tools.every(t => typeof t.description === 'string' && t.parameters)).toBe(true);
  });

  it('rejects an unknown method', async () => {
    await h.handle(req('does.not.exist'));
    const r = c.res('t' + n);
    expect(r?.ok).toBe(false);
    expect((r as { ok: false; error: { code: string } }).error.code).toBe('unknown_method');
  });

  it('rejects a missing session', async () => {
    await h.handle(req(M.usageGet, { sessionId: 'nope' }));
    expect((c.res('t' + n) as { ok: false; error: { code: string } }).error.code).toBe('no_such_session');
  });

  it('rejects a missing sessionId', async () => {
    await h.handle(req(M.usageGet, {}));
    expect((c.res('t' + n) as { ok: false; error: { code: string } }).error.code).toBe('bad_params');
  });

  it('rejects an empty turn message', async () => {
    const id = await create();
    await h.handle(req(M.turnSend, { sessionId: id, message: '   ' }));
    expect((c.res('t' + n) as { ok: false; error: { code: string } }).error.code).toBe('bad_params');
  });

  it('refuses a turn when the session budget is already exhausted', async () => {
    const id = await create({ maxInputTokens: 1 });
    // Spend the ceiling without a provider.
    const budget = (h as unknown as { sessions: Map<string, { budget: { recordCall(n: number): void } }> })
      .sessions.get(id)!.budget;
    budget.recordCall(50);

    await h.handle(req(M.turnSend, { sessionId: id, message: 'go' }));
    expect((c.res('t' + n) as { ok: false; error: { code: string } }).error.code).toBe('budget_exhausted');
  });

  it('ignores event frames sent by a client', async () => {
    const before = c.frames.length;
    await h.handle({ kind: 'evt', method: 'turn.delta', params: {} });
    expect(c.frames).toHaveLength(before);
  });

  // ── Approval ──────────────────────────────────────────────────────────────

  it('asks the client for approval and honours allow', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as {
      askApproval(s: unknown, t: string, m: string, ctx?: unknown): Promise<boolean>;
    }).askApproval.bind(h);

    const pending = ask(s, 'turn1', 'Allow: $ rm -rf /tmp/x?', { toolName: 'run_shell', input: { command: 'rm -rf /tmp/x' } });
    const [request] = c.reqs(M.approvalRequest);
    expect(request).toBeDefined();
    // Structured, not prose-derived — this is what a client renders.
    expect(request.params).toMatchObject({
      tool: 'run_shell',
      args: { command: 'rm -rf /tmp/x' },
      tier: 3,
      rendered: 'Allow: $ rm -rf /tmp/x?',
    });

    await h.handle({ kind: 'res', id: request.id, ok: true, result: { decision: 'allow' } });
    await expect(pending).resolves.toBe(true);
  });

  it('honours deny', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);
    const pending = ask(s, 'turn1', 'Allow: x?', { toolName: 'run_shell', input: {} });
    const [request] = c.reqs(M.approvalRequest);
    await h.handle({ kind: 'res', id: request.id, ok: true, result: { decision: 'deny' } });
    await expect(pending).resolves.toBe(false);
  });

  it('denies on timeout — silence is never consent', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);
    // approvalTimeoutMs is 200 for this handler; never answer.
    await expect(ask(s, 'turn1', 'Allow: x?', { toolName: 'run_shell', input: {} })).resolves.toBe(false);
  });

  it('denies when the client answers with an error', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);
    const pending = ask(s, 'turn1', 'Allow: x?', { toolName: 'run_shell', input: {} });
    const [request] = c.reqs(M.approvalRequest);
    await h.handle({ kind: 'res', id: request.id, ok: false, error: { code: 'internal', message: 'client blew up' } });
    await expect(pending).resolves.toBe(false);
  });

  it('treats an unrecognised decision as deny', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);
    const pending = ask(s, 'turn1', 'Allow: x?', { toolName: 'run_shell', input: {} });
    const [request] = c.reqs(M.approvalRequest);
    await h.handle({ kind: 'res', id: request.id, ok: true, result: { decision: 'maybe?' } });
    await expect(pending).resolves.toBe(false);
  });

  it('allow_always_session stops re-asking for that tool', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);

    const first = ask(s, 't', 'Allow: $ ls?', { toolName: 'run_shell', input: {} });
    const [r1] = c.reqs(M.approvalRequest);
    await h.handle({ kind: 'res', id: r1.id, ok: true, result: { decision: 'allow_always_session' } });
    await expect(first).resolves.toBe(true);

    // Second call for the same tool must not produce another request.
    const before = c.reqs(M.approvalRequest).length;
    await expect(ask(s, 't', 'Allow: $ pwd?', { toolName: 'run_shell', input: {} })).resolves.toBe(true);
    expect(c.reqs(M.approvalRequest)).toHaveLength(before);

    // A different tool still asks.
    void ask(s, 't', 'Allow: overwrite x?', { toolName: 'write_file', input: {} });
    expect(c.reqs(M.approvalRequest).length).toBe(before + 1);
  });

  it('dispose denies everything still pending', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);
    const pending = ask(s, 't', 'Allow: x?', { toolName: 'run_shell', input: {} });
    h.dispose();
    await expect(pending).resolves.toBe(false);
  });

  /**
   * Regression: the stdio transport used to serialise frames through one
   * promise chain, so an approval response queued behind the turn.send that
   * was waiting for it. The turn blocked until the approval timed out and
   * denied — an `allow` was sent and the tool still came back
   * "denied by user". A response must be processable while a request is
   * still in flight.
   */
  it('processes a response while an earlier request is still pending', async () => {
    const id = await create();
    const s = (h as unknown as { sessions: Map<string, unknown> }).sessions.get(id)!;
    const ask = (h as unknown as { askApproval(...a: unknown[]): Promise<boolean> }).askApproval.bind(h);

    let released = false;
    const longRunning = ask(s, 't', 'Allow: x?', { toolName: 'run_shell', input: {} })
      .then(v => { released = true; return v; });

    const [request] = c.reqs(M.approvalRequest);
    expect(released).toBe(false);
    await h.handle({ kind: 'res', id: request.id, ok: true, result: { decision: 'allow' } });
    await expect(longRunning).resolves.toBe(true);
    expect(released).toBe(true);
  });
});

describe('confirm() structured context', () => {
  afterEach(() => setConfirmHandler(null));

  it('passes tool name and input through to the handler', async () => {
    const seen: { message: string; ctx?: { toolName: string; input: Record<string, unknown> } }[] = [];
    setConfirmHandler(async (message, ctx) => { seen.push({ message, ctx }); return true; });

    await confirm('Allow: $ npm install?', { toolName: 'run_shell', input: { command: 'npm install' } });

    expect(seen).toHaveLength(1);
    expect(seen[0].ctx).toEqual({ toolName: 'run_shell', input: { command: 'npm install' } });
  });

  it('still works for handlers that ignore the context', async () => {
    setConfirmHandler(async () => true);
    await expect(confirm('Allow: x?')).resolves.toBe(true);
  });
});

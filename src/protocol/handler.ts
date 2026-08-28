import { randomUUID } from 'crypto';
import { createProvider } from '../providers/factory.js';
import { loadProjectContext, type ProjectContext } from '../agent/context.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem, setConfirmHandler, type ConfirmContext } from '../safety/permissions.js';
import { SessionBudget } from '../agent/session-budget.js';
import { TOOL_DEFINITIONS } from '../tools/index.js';
import type { Display } from '../cli/display.js';
import type { HistoryMessage } from '../providers/types.js';
import {
  M,
  type ApprovalDecision,
  type EvtFrame,
  type Frame,
  type ProtocolError,
  type ReqFrame,
  type ResFrame,
  type SessionSummary,
  type ToolInfo,
} from './types.js';

/**
 * Transport-agnostic protocol handler.
 *
 * Owns every session and all message semantics. Knows nothing about stdio,
 * sockets, or framing — a transport hands it parsed {@link Frame}s and
 * supplies a `send` callback. `aura sidecar` and `aura serve` are both thin
 * adapters over this one class, which is what keeps the two transports from
 * drifting into different protocols.
 */

export interface HandlerOptions {
  /** Model used when session.create omits one. */
  defaultModel: string;
  defaultApiKey?: string;
  defaultBaseUrl?: string;
  /** Fallback project root for a session.create that omits one. */
  defaultProjectRoot: string;
  /** Frame sink. The transport serialises and writes it. */
  send: (frame: Frame) => void;
  /** How long to wait for an approval answer before denying. */
  approvalTimeoutMs?: number;
}

interface Session {
  id: string;
  name?: string;
  projectRoot: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  context: ProjectContext;
  permissions: PermissionSystem;
  budget: SessionBudget;
  history: HistoryMessage[];
  createdAt: number;
  /** Non-null while a turn is running — one turn per session at a time. */
  activeTurn: { turnId: string; abort: AbortController } | null;
  /** Tools the client approved for the rest of this session. */
  alwaysAllow: Set<string>;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export class ProtocolHandler {
  private sessions = new Map<string, Session>();
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private opts: HandlerOptions;

  constructor(opts: HandlerOptions) {
    this.opts = opts;
  }

  /** Announce readiness. Transports call this once the channel is open. */
  ready(): void {
    this.emit(M.engineReady, undefined, {
      protocolVersion: 1,
      defaultModel: this.opts.defaultModel,
      defaultProjectRoot: this.opts.defaultProjectRoot,
    });
  }

  /** Cancel everything in flight. Called when the transport closes. */
  dispose(): void {
    for (const resolve of this.pendingApprovals.values()) resolve('deny');
    this.pendingApprovals.clear();
    for (const s of this.sessions.values()) s.activeTurn?.abort.abort();
    setConfirmHandler(null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frame intake
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Handle one inbound frame. Never throws and never rejects: a failure is
   * reported as a `res` with ok:false, because a transport that has to catch
   * exceptions per-frame ends up reimplementing error semantics.
   */
  async handle(frame: Frame): Promise<void> {
    try {
      if (frame.kind === 'res') {
        this.resolveApproval(frame);
        return;
      }
      if (frame.kind === 'evt') return; // clients do not send events
      if (frame.kind !== 'req') {
        this.fail('', { code: 'bad_frame', message: 'Frame kind must be req, res, or evt.' });
        return;
      }
      await this.dispatch(frame);
    } catch (e) {
      const id = 'id' in frame ? frame.id : '';
      this.fail(id, { code: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async dispatch(req: ReqFrame): Promise<void> {
    const p = req.params ?? {};
    switch (req.method) {
      case M.sessionCreate:   return this.sessionCreate(req, p);
      case M.sessionDestroy:  return this.sessionDestroy(req, p);
      case M.sessionList:     return this.ok(req.id, { sessions: this.listSessions() });
      case M.sessionHistory:  return this.sessionHistory(req, p);
      case M.sessionState:    return this.sessionState(req, p);
      case M.turnSend:        return this.turnSend(req, p);
      case M.turnCancel:      return this.turnCancel(req, p);
      case M.toolsList:       return this.ok(req.id, { tools: this.listTools() });
      case M.usageGet:        return this.usageGet(req, p);
      default:
        return this.fail(req.id, { code: 'unknown_method', message: `Unknown method: ${req.method}` });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Methods
  // ───────────────────────────────────────────────────────────────────────────

  private async sessionCreate(req: ReqFrame, p: Record<string, unknown>): Promise<void> {
    const projectRoot = typeof p.projectRoot === 'string' && p.projectRoot
      ? p.projectRoot
      : this.opts.defaultProjectRoot;
    const model = typeof p.model === 'string' && p.model ? p.model : this.opts.defaultModel;
    // An unrecognised level falls back to 'normal' rather than to the most
    // permissive reading of a typo.
    const permission: 'read-only' | 'normal' | 'auto' =
      p.permission === 'read-only' || p.permission === 'auto' ? p.permission : 'normal';
    if (!model) {
      return this.fail(req.id, { code: 'bad_params', message: 'No model given and no engine default configured.' });
    }

    let context: ProjectContext;
    try {
      context = await loadProjectContext(projectRoot);
    } catch (e) {
      return this.fail(req.id, {
        code: 'bad_params',
        message: `Cannot load project root "${projectRoot}": ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const id = randomUUID();
    const maxInputTokens = typeof p.maxInputTokens === 'number' ? p.maxInputTokens : undefined;
    const session: Session = {
      id,
      name: typeof p.name === 'string' ? p.name : undefined,
      projectRoot,
      model,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : this.opts.defaultApiKey,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : this.opts.defaultBaseUrl,
      context,
      permissions: new PermissionSystem(permission),
      // Per session, not per process: two concurrent sessions get independent
      // ceilings rather than racing each other toward one shared total.
      budget: new SessionBudget(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      history: [],
      createdAt: Date.now(),
      activeTurn: null,
      alwaysAllow: new Set(),
    };
    this.sessions.set(id, session);

    this.ok(req.id, { sessionId: id, projectRoot, model, name: session.name });
  }

  private sessionDestroy(req: ReqFrame, p: Record<string, unknown>): void {
    const s = this.lookup(req, p);
    if (!s) return;
    s.activeTurn?.abort.abort();
    this.sessions.delete(s.id);
    this.ok(req.id, { destroyed: true });
  }

  private sessionHistory(req: ReqFrame, p: Record<string, unknown>): void {
    const s = this.lookup(req, p);
    if (!s) return;
    this.ok(req.id, { messages: s.history });
  }

  private sessionState(req: ReqFrame, p: Record<string, unknown>): void {
    const s = this.lookup(req, p);
    if (!s) return;
    this.ok(req.id, {
      sessionId: s.id,
      name: s.name,
      projectRoot: s.projectRoot,
      model: s.model,
      busy: s.activeTurn !== null,
      messageCount: s.history.length,
      tools: this.listTools(),
      usage: this.usageOf(s),
    });
  }

  private usageGet(req: ReqFrame, p: Record<string, unknown>): void {
    const s = this.lookup(req, p);
    if (!s) return;
    this.ok(req.id, this.usageOf(s));
  }

  private turnCancel(req: ReqFrame, p: Record<string, unknown>): void {
    const s = this.lookup(req, p);
    if (!s) return;
    const was = s.activeTurn !== null;
    s.activeTurn?.abort.abort();
    this.ok(req.id, { cancelled: was });
  }

  /**
   * Start a turn. Responds immediately with the turnId; the work streams as
   * events and finishes with `turn.completed`. A client that awaited the
   * response before reading events would deadlock on approval, since the
   * engine blocks mid-turn waiting for the client to answer.
   */
  private async turnSend(req: ReqFrame, p: Record<string, unknown>): Promise<void> {
    const s = this.lookup(req, p);
    if (!s) return;
    if (typeof p.message !== 'string' || !p.message.trim()) {
      return this.fail(req.id, { code: 'bad_params', message: 'params.message must be a non-empty string.' });
    }
    if (s.activeTurn) {
      return this.fail(req.id, { code: 'session_busy', message: `Session ${s.id} already has a turn running.` });
    }

    const budgetStop = s.budget.exhausted();
    if (budgetStop) {
      return this.fail(req.id, {
        code: 'budget_exhausted',
        message: `Session budget exhausted (${budgetStop.used}/${budgetStop.limit} ${budgetStop.kind}).`,
      });
    }

    const turnId = randomUUID();
    const abort = new AbortController();
    s.activeTurn = { turnId, abort };
    this.ok(req.id, { turnId });
    this.emit(M.turnStarted, s.id, { turnId });

    // Approvals are routed per-session for the duration of the turn. The
    // handler is single-flight per session, but two SESSIONS can run turns
    // concurrently, so this is set immediately before the loop rather than
    // once at construction.
    setConfirmHandler((message: string, ctx?: ConfirmContext) => this.askApproval(s, turnId, message, ctx));

    try {
      const provider = createProvider({
        model: s.model,
        apiKey: s.apiKey,
        baseUrl: s.baseUrl,
      });

      // Only well-formed image data URIs are forwarded. Anything else is
      // dropped rather than handed to a provider as an opaque blob.
      const images = Array.isArray(p.images)
        ? (p.images as unknown[]).filter(
          (i): i is string => typeof i === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(i),
        )
        : undefined;

      const result = await runAgentLoop({
        provider,
        task: p.message,
        ...(images && images.length > 0 ? { images } : {}),
        context: s.context,
        permissions: s.permissions,
        display: this.displayFor(s, turnId),
        budget: s.budget,
        initialHistory: s.history,
        abortSignal: abort.signal,
      });

      s.history = result.history;
      this.emit(M.turnCompleted, s.id, {
        turnId,
        success: result.success,
        summary: result.summary,
        turns: result.turns,
        toolCount: result.toolCallCount,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedTokens: result.usage.cachedTokens,
          costUsd: result.costUsd,
        },
        budgetStopped: /budget/i.test(result.summary) && !result.success,
      });
    } catch (e) {
      this.emit(M.turnError, s.id, {
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
      this.emit(M.turnCompleted, s.id, {
        turnId, success: false,
        summary: e instanceof Error ? e.message : String(e),
        turns: 0, toolCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
      });
    } finally {
      s.activeTurn = null;
      setConfirmHandler(null);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approval
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Ask the client to approve a tool. Resolves false (deny) on timeout or if
   * the transport drops — silence must never read as consent.
   *
   * The engine currently reaches here only through `confirm()`, which fires
   * for exactly the actions Phase 5 will classify as tier 3, so the tier is
   * reported as 3. When the tiering lands it fills this in properly without
   * a wire change.
   */
  private askApproval(
    s: Session,
    _turnId: string,
    message: string,
    ctx?: ConfirmContext,
  ): Promise<boolean> {
    const tool = ctx?.toolName ?? '';
    if (tool && s.alwaysAllow.has(tool)) return Promise.resolve(true);

    const id = randomUUID();
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingApprovals.delete(id);
        if (decision === 'allow_always_session' && tool) s.alwaysAllow.add(tool);
        resolve(decision !== 'deny');
      };
      const timer = setTimeout(
        () => finish('deny'),
        this.opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      );
      this.pendingApprovals.set(id, finish);

      this.opts.send({
        kind: 'req',
        id,
        method: M.approvalRequest,
        params: {
          sessionId: s.id,
          tool,
          args: ctx?.input ?? {},
          tier: 3,
          rendered: message,
        },
      });
    });
  }

  /** Match a client's `res` back to the approval request it answers. */
  private resolveApproval(frame: ResFrame): void {
    const pending = this.pendingApprovals.get(frame.id);
    if (!pending) return;
    if (!frame.ok) { pending('deny'); return; }
    const decision = frame.result?.decision;
    pending(
      decision === 'allow' || decision === 'allow_always_session'
        ? decision
        : 'deny',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /** Bridges the engine's Display interface onto protocol events. */
  private displayFor(s: Session, turnId: string): Display {
    const evt = (method: string, params: Record<string, unknown>) => this.emit(method, s.id, params);
    const noop = () => {};
    return {
      agentThinking: noop,
      streamText: (text: string) => evt(M.turnDelta, { turnId, text }),
      streamEnd: noop,
      toolStart: noop,
      toolCall: (name, input) => evt(M.turnToolCall, { turnId, name, input }),
      toolResult: (name, result, elapsedMs) => evt(M.turnToolResult, { turnId, name, result, elapsedMs }),
      toolBlocked: (name, reason) => evt(M.turnToolBlocked, { turnId, name, reason }),
      warning: (msg: string) => evt(M.log, { turnId, level: 'warning', message: msg }),
      success: (msg: string) => evt(M.log, { turnId, level: 'success', message: msg }),
      error: (msg: string) => evt(M.log, { turnId, level: 'error', message: msg }),
      header: noop,
      summary: noop,
      showPlan: noop,
      stepStarted: noop,
      stepCompleted: noop,
    };
  }

  private usageOf(s: Session) {
    return {
      inputTokensUsed: s.budget.inputTokensUsed,
      maxInputTokens: Number.isFinite(s.budget.maxInputTokens) ? s.budget.maxInputTokens : null,
      turnsUsed: s.budget.turnsUsed,
      exhausted: s.budget.exhausted() !== null,
    };
  }

  private listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(s => ({
      sessionId: s.id,
      name: s.name,
      projectRoot: s.projectRoot,
      model: s.model,
      createdAt: s.createdAt,
      busy: s.activeTurn !== null,
      turnsUsed: s.budget.turnsUsed,
      inputTokensUsed: s.budget.inputTokensUsed,
    }));
  }

  private listTools(): ToolInfo[] {
    return TOOL_DEFINITIONS.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    }));
  }

  private lookup(req: ReqFrame, p: Record<string, unknown>): Session | null {
    const id = p.sessionId;
    if (typeof id !== 'string' || !id) {
      this.fail(req.id, { code: 'bad_params', message: 'params.sessionId is required.' });
      return null;
    }
    const s = this.sessions.get(id);
    if (!s) {
      this.fail(req.id, { code: 'no_such_session', message: `No such session: ${id}` });
      return null;
    }
    return s;
  }

  private ok(id: string, result: Record<string, unknown>): void {
    this.opts.send({ kind: 'res', id, ok: true, result });
  }

  private fail(id: string, error: ProtocolError): void {
    this.opts.send({ kind: 'res', id, ok: false, error });
  }

  private emit(method: string, sessionId: string | undefined, params: Record<string, unknown>): void {
    const frame: EvtFrame = { kind: 'evt', method, params };
    if (sessionId) frame.sessionId = sessionId;
    this.opts.send(frame);
  }
}

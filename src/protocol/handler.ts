import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { createProvider } from '../providers/factory.js';
import { loadProjectContext, type ProjectContext } from '../agent/context.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem, setConfirmHandler, type ConfirmContext } from '../safety/permissions.js';
import { SessionBudget } from '../agent/session-budget.js';
import { TOOL_DEFINITIONS } from '../tools/index.js';
import {
  addTask, loadBoard, removeAttachments, removeTask, saveBoard, taskPrompt, updateTask,
} from '../board/store.js';
import { BOARD_AGENTS, BOARD_COLUMNS, type BoardColumn, type BoardAgent } from '../board/types.js';
import { agentPresets, effectivePermission, AGENT_PRESETS } from '../board/agents.js';
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

/** Answers one approval, for one turn. */
type Ask = (message: string, ctx?: ConfirmContext) => Promise<boolean>;

/**
 * Which turn the approval currently being asked about belongs to.
 *
 * `confirm()` is a global side channel — the tool layer calls it with no way to
 * say which session it is running for — so the routing was previously "whichever
 * turn installed the handler last". With two turns in flight that is wrong twice
 * over: the second turn's approvals were attributed to the first, and whichever
 * turn finished first ran `setConfirmHandler(null)` in its `finally` and left
 * the other one with no handler at all. Its next approval then fell through to
 * the terminal `[Y/n]` prompt, where nobody is watching a server, and the turn
 * blocked until it timed out.
 *
 * AsyncLocalStorage fixes it properly: the agent loop runs inside the store, so
 * a confirm raised anywhere beneath it finds its own turn no matter how many
 * others are running.
 */
const currentTurn = new AsyncLocalStorage<Ask>();

/**
 * Installed once for the process, not once per turn.
 *
 * With no owning turn the answer is "no". A server has no terminal anyone is
 * reading, so the alternative is a prompt that hangs for ever — and silence
 * must never read as consent.
 */
setConfirmHandler((message: string, ctx?: ConfirmContext) => {
  const ask = currentTurn.getStore();
  return ask ? ask(message, ctx) : Promise.resolve(false);
});

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
  /** Client-chosen tool allowlist, or null for every tool. */
  allowedTools: string[] | null;
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
    // The confirm handler is deliberately NOT cleared. `aura serve` builds one
    // ProtocolHandler per socket, so one browser tab closing would otherwise
    // strip approval routing from every other tab's running turn — the same
    // fault the per-turn install had, just with a different trigger.
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
      case M.boardGet:        return this.boardGet(req, p);
      case M.boardAdd:        return this.boardAdd(req, p);
      case M.boardUpdate:     return this.boardUpdate(req, p);
      case M.boardRemove:     return this.boardRemove(req, p);
      case M.boardRun:        return this.boardRun(req, p);
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
    // Unknown names are dropped rather than rejected: a client built against an
    // older tool set should lose the tool, not the session. An empty result
    // means "no tools", which is a legitimate ask, so null is the only "all".
    const known = new Set(TOOL_DEFINITIONS.map((d) => d.name));
    const allowedTools = Array.isArray(p.allowedTools)
      ? (p.allowedTools as unknown[])
        .filter((n): n is string => typeof n === 'string')
        .filter((n) => known.has(n))
      : null;
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
      allowedTools,
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
    this.ok(req.id, { turnId });
    await this.runTurn(s, turnId, p.message, p.images);
  }

  /**
   * Run one turn on a session and announce how it went.
   *
   * Split out of turnSend so `board.run` can drive the same machinery. The
   * caller has already replied to its own request by the time this starts —
   * a turn takes minutes, and holding the response open for it would time out
   * every client.
   */
  private async runTurn(
    s: Session,
    turnId: string,
    message: string,
    rawImages?: unknown,
  ): Promise<{ success: boolean; summary: string }> {
    const p = { images: rawImages } as Record<string, unknown>;
    const abort = new AbortController();
    s.activeTurn = { turnId, abort };
    this.emit(M.turnStarted, s.id, { turnId });

    const ask: Ask = (message, ctx) => this.askApproval(s, turnId, message, ctx);

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

      // Inside the store, so every confirm raised beneath this loop routes back
      // to *this* turn's client even while other turns are running.
      const result = await currentTurn.run(ask, () => runAgentLoop({
        provider,
        task: message,
        ...(images && images.length > 0 ? { images } : {}),
        context: s.context,
        permissions: s.permissions,
        display: this.displayFor(s, turnId),
        ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}),
        budget: s.budget,
        initialHistory: s.history,
        abortSignal: abort.signal,
      }));

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
      return { success: result.success, summary: result.summary };
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
      return { success: false, summary: e instanceof Error ? e.message : String(e) };
    } finally {
      // Only the turn's own state is cleared. The confirm handler is
      // process-wide and must outlive any single turn — clearing it here is
      // what stranded concurrent turns.
      s.activeTurn = null;
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


  // ── Board ──────────────────────────────────────────────────────────────────
  //
  // The board is per project, not per session: a task outlives the chat it was
  // planned in, and binding it to a session would delete the user's planning
  // every time they started a new conversation.

  /** The project root a board request applies to. */
  private boardRoot(p: Record<string, unknown>): string {
    return typeof p.projectRoot === 'string' && p.projectRoot
      ? p.projectRoot
      : this.opts.defaultProjectRoot;
  }

  /**
   * Persist and announce in one step.
   *
   * Every mutation broadcasts `board.changed` with the whole board rather than
   * a delta. The board is small, and two windows open on the same project
   * reconciling deltas is a synchronisation problem worth more than it solves.
   */
  private boardCommit(root: string, state: ReturnType<typeof loadBoard>): void {
    saveBoard(root, state);
    this.emit(M.boardChanged, undefined, { projectRoot: root, tasks: state.tasks });
  }

  private boardGet(req: ReqFrame, p: Record<string, unknown>): void {
    const root = this.boardRoot(p);
    this.ok(req.id, {
      projectRoot: root,
      tasks: loadBoard(root).tasks,
      // The client renders the pickers from these, so an agent added to the
      // engine appears in the UI without a matching frontend release — and,
      // more importantly, the client dispatches with the engine's own
      // permission and tool set rather than a copy that can drift.
      columns: BOARD_COLUMNS,
      agents: BOARD_AGENTS,
      presets: agentPresets(),
    });
  }

  private boardAdd(req: ReqFrame, p: Record<string, unknown>): void {
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!title) {
      return this.fail(req.id, { code: 'bad_params', message: 'A task needs a title.' });
    }
    const root = this.boardRoot(p);
    const state = loadBoard(root);
    const task = addTask(state, {
      title,
      notes: typeof p.notes === 'string' ? p.notes : undefined,
      column: typeof p.column === 'string' ? p.column as BoardColumn : undefined,
      agent: typeof p.agent === 'string' ? p.agent as BoardAgent : undefined,
      model: typeof p.model === 'string' ? p.model : undefined,
    });
    this.boardCommit(root, state);
    this.ok(req.id, { task });
  }

  private boardUpdate(req: ReqFrame, p: Record<string, unknown>): void {
    const id = typeof p.id === 'string' ? p.id : '';
    const root = this.boardRoot(p);
    const state = loadBoard(root);
    // Only forward keys the caller actually sent: an absent key must not
    // overwrite a stored value with undefined, or moving a tile would erase
    // its notes.
    const patch: Record<string, unknown> = {};
    for (const key of ['title', 'notes', 'column', 'agent', 'model', 'sessionId', 'result', 'failed', 'order']) {
      if (p[key] !== undefined) patch[key] = p[key];
    }
    const task = updateTask(state, id, patch);
    if (!task) {
      return this.fail(req.id, { code: 'no_such_task', message: `No task with id "${id}".` });
    }
    this.boardCommit(root, state);
    this.ok(req.id, { task });
  }

  private boardRemove(req: ReqFrame, p: Record<string, unknown>): void {
    const id = typeof p.id === 'string' ? p.id : '';
    const root = this.boardRoot(p);
    const state = loadBoard(root);
    if (!removeTask(state, id)) {
      return this.fail(req.id, { code: 'no_such_task', message: `No task with id "${id}".` });
    }
    // The files go with the task. Leaving them would accumulate uploads nobody
    // can see or reach, in a directory the user never opens.
    removeAttachments(root, id);
    this.boardCommit(root, state);
    this.ok(req.id, { removed: id });
  }


  /**
   * Run a board task, and put the answer back on it.
   *
   * The engine owns this from end to end, and that is the whole point. The
   * first version dispatched from the browser — session.create, turn.send, and
   * a React ref remembering which task the turn belonged to. Reload the page or
   * restart the server and that link was gone, so the tile sat in `execution`
   * for ever with no way back. Completion has to be owned by the thing that
   * survives a refresh.
   *
   * The response returns as soon as the task is moved and the turn is started.
   * A run takes minutes; holding the request open for it would time out every
   * client, and the board updates over board.changed anyway.
   */
  private async boardRun(req: ReqFrame, p: Record<string, unknown>): Promise<void> {
    const id = typeof p.id === 'string' ? p.id : '';
    const root = this.boardRoot(p);
    const state = loadBoard(root);
    const task = state.tasks.find((t) => t.id === id);
    if (!task) {
      return this.fail(req.id, { code: 'no_such_task', message: `No task with id "${id}".` });
    }
    if (task.column === 'execution') {
      return this.fail(req.id, { code: 'session_busy', message: `Task "${task.title}" is already running.` });
    }

    const preset = AGENT_PRESETS[task.agent] ?? AGENT_PRESETS.aura;
    // The caller's own permission level, capped by the agent's preset — see
    // effectivePermission. Without it "auto" in Settings did nothing here and
    // every shell command still asked.
    const chosen = p.permission === 'read-only' || p.permission === 'normal' || p.permission === 'auto'
      ? p.permission
      : undefined;
    const permission = effectivePermission(preset, chosen);
    const model = task.model || this.opts.defaultModel;
    if (!model) {
      return this.fail(req.id, { code: 'bad_params', message: 'No model configured for this task.' });
    }

    let context: ProjectContext;
    try {
      context = await loadProjectContext(root);
    } catch (e) {
      return this.fail(req.id, {
        code: 'bad_params',
        message: `Cannot load project root "${root}": ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      name: task.title.slice(0, 60),
      projectRoot: root,
      model,
      apiKey: this.opts.defaultApiKey,
      baseUrl: this.opts.defaultBaseUrl,
      context,
      // The agent's preset, enforced by the engine rather than suggested to the
      // model — a read-only reviewer cannot edit however it is prompted.
      permissions: new PermissionSystem(permission),
      allowedTools: preset.allowedTools ?? null,
      budget: new SessionBudget({}),
      history: [],
      createdAt: Date.now(),
      activeTurn: null,
      alwaysAllow: new Set(),
    };
    this.sessions.set(sessionId, session);

    updateTask(state, id, { column: 'execution', sessionId, result: undefined, failed: false });
    this.boardCommit(root, state);

    const turnId = randomUUID();
    this.ok(req.id, { sessionId, turnId });

    const outcome = await this.runTurn(session, turnId, taskPrompt(task));

    // Re-read rather than mutating the copy captured above: minutes have
    // passed, and the user may have edited the tile while it ran.
    const after = loadBoard(root);
    updateTask(after, id, {
      column: 'finished',
      result: outcome.summary,
      failed: !outcome.success,
    });
    this.boardCommit(root, after);
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

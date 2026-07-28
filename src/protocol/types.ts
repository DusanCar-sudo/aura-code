/**
 * The Aura engine protocol — one message schema, two transports.
 *
 * `aura sidecar` carries these frames as newline-delimited JSON over stdio
 * (Tauri spawns the engine as a child process). `aura serve` carries the
 * identical frames over its existing WebSocket. Neither transport may add,
 * rename, or reshape a field: docs/PROTOCOL.md is the source of truth and
 * both adapters are deliberately thin.
 *
 * Frames are symmetric — both sides can issue a request and must answer one.
 * That symmetry is what makes tool approval work: the engine asks the client
 * whether a tool may run, and blocks on the reply.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────────────────

/** A call that expects exactly one matching {@link ResFrame}. */
export interface ReqFrame {
  kind: 'req';
  /** Unique per sender. Echoed on the response. */
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** The answer to a {@link ReqFrame} with the same `id`. */
export type ResFrame =
  | { kind: 'res'; id: string; ok: true; result: Record<string, unknown> }
  | { kind: 'res'; id: string; ok: false; error: ProtocolError };

/** A one-way notification. Never answered. */
export interface EvtFrame {
  kind: 'evt';
  method: string;
  /** Absent only for engine-wide events such as `engine.ready`. */
  sessionId?: string;
  params?: Record<string, unknown>;
}

export type Frame = ReqFrame | ResFrame | EvtFrame;

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | 'bad_frame'          // unparseable or structurally invalid
  | 'unknown_method'
  | 'bad_params'
  | 'no_such_session'
  | 'session_busy'       // a turn is already running on this session
  | 'budget_exhausted'
  | 'provider_error'
  | 'internal';

// ─────────────────────────────────────────────────────────────────────────────
// Client → engine requests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shapes mirror aura-mathetes' existing `#[tauri::command]` surface so the
 * Tauri rewrite in Phase 3 is mechanical:
 *   create_agent        → session.create
 *   run_agent           → turn.send
 *   get_agent_messages  → session.history
 *   list_tools          → tools.list
 *   get_workspace_state → session.state
 */
export interface SessionCreateParams {
  /** Absolute path. Scopes session storage, memory, and every file tool. */
  projectRoot: string;
  /** Routing id, e.g. "anthropic/claude-sonnet-4-5". Falls back to engine default. */
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Display name only — never affects routing. */
  name?: string;
  /** Cumulative billed-input ceiling. Omit for the configured default. */
  maxInputTokens?: number;
}

export interface SessionCreateResult {
  sessionId: string;
  projectRoot: string;
  model: string;
  name?: string;
}

export interface SessionRef { sessionId: string }

export interface SessionSummary {
  sessionId: string;
  name?: string;
  projectRoot: string;
  model: string;
  createdAt: number;
  busy: boolean;
  turnsUsed: number;
  inputTokensUsed: number;
}

export interface TurnSendParams {
  sessionId: string;
  /** The user's instruction. Replaces run_agent's `goal`. */
  message: string;
}

export interface TurnSendResult {
  /** Correlates the events this turn emits. Completion arrives as an event. */
  turnId: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema, passed through from the engine's tool definition. */
  parameters: Record<string, unknown>;
}

export interface UsageResult {
  inputTokensUsed: number;
  maxInputTokens: number | null;   // null = unlimited
  turnsUsed: number;
  /** True once the ceiling is reached; further turns are refused. */
  exhausted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine → client requests (the engine blocks on the answer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tier is carried now so the Phase 5 guard does not change the wire format.
 * Until then the engine emits tier 3 for anything that reaches confirm().
 *
 *   1 auto           — reads, searches, memory lookups
 *   2 accept-edits   — writes inside the project root
 *   3 approval       — outside the root, installs, network, push, destructive
 *   4 bypass         — not implemented
 */
export type ApprovalTier = 1 | 2 | 3 | 4;

export interface ApprovalRequestParams {
  sessionId: string;
  /** Tool being invoked, e.g. "run_shell". Empty when the engine only has prose. */
  tool: string;
  args: Record<string, unknown>;
  tier: ApprovalTier;
  /** Human-readable one-liner to show in the modal. Always populated. */
  rendered: string;
}

export type ApprovalDecision =
  | 'allow'
  | 'deny'
  /** Allow this exact tool for the rest of the session without re-asking. */
  | 'allow_always_session';

export interface ApprovalResponseResult {
  decision: ApprovalDecision;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine → client events
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnStartedEvent { turnId: string }
export interface TurnDeltaEvent { turnId: string; text: string }
export interface ToolCallEvent { turnId: string; name: string; input: Record<string, unknown> }
export interface ToolResultEvent { turnId: string; name: string; result: string; elapsedMs: number }
export interface ToolBlockedEvent { turnId: string; name: string; reason: string }

export interface TurnCompletedEvent {
  turnId: string;
  success: boolean;
  /** Final assistant text, or the reason the loop stopped. */
  summary: string;
  turns: number;
  toolCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  };
  /** Set when the loop stopped on the session ceiling rather than finishing. */
  budgetStopped?: boolean;
}

/** Method-name constants, so adapters and tests cannot drift on a typo. */
export const M = {
  // client → engine
  sessionCreate: 'session.create',
  sessionDestroy: 'session.destroy',
  sessionList: 'session.list',
  sessionHistory: 'session.history',
  sessionState: 'session.state',
  turnSend: 'turn.send',
  turnCancel: 'turn.cancel',
  toolsList: 'tools.list',
  usageGet: 'usage.get',
  // engine → client (request)
  approvalRequest: 'approval.request',
  // engine → client (events)
  engineReady: 'engine.ready',
  turnStarted: 'turn.started',
  turnDelta: 'turn.delta',
  turnToolCall: 'turn.tool_call',
  turnToolResult: 'turn.tool_result',
  turnToolBlocked: 'turn.tool_blocked',
  turnCompleted: 'turn.completed',
  turnError: 'turn.error',
  log: 'log',
} as const;

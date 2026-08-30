import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProtocolClient, M, type ConnectionState } from '../lib/protocol';
import { useBoard, type BoardTask } from './useBoard';
import type { Settings } from '../lib/settings';

/**
 * The client's whole state machine.
 *
 * The engine owns conversation truth; this hook owns what the screen needs to
 * paint between events. Streaming deltas are accumulated into the last
 * assistant message rather than appended as new ones, so a turn renders as one
 * growing answer instead of a stack of fragments.
 */

export type Role = 'user' | 'assistant' | 'system';

export interface ToolEvent {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  blocked?: string;
  elapsedMs?: number;
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  /** Tool activity that happened while producing this message. */
  tools: ToolEvent[];
  /** Still receiving deltas. */
  streaming?: boolean;
  error?: string;
  at: number;
}

export interface Conversation {
  sessionId: string;
  title: string;
  at: number;
}

export interface PendingApproval {
  /** Resolve with true to allow, false to deny. */
  resolve: (allowed: boolean) => void;
  tool: string;
  detail: string;
  /** 1 auto · 2 accept-edits · 3 approval · 4 bypass (see ApprovalTier). */
  tier: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  contextUsed?: number;
  contextWindow?: number;
}

const MAX_MESSAGES_BUFFER = 200;
const MAX_TOOLS_PER_MESSAGE = 500;
const MAX_TEXT_LENGTH = 200_000;

export function pruneMessages(msgs: Message[]): Message[] {
  let changed = false;
  let result = msgs;
  if (result.length > MAX_MESSAGES_BUFFER) {
    result = result.slice(result.length - MAX_MESSAGES_BUFFER);
    changed = true;
  }
  const mapped = result.map((m) => {
    let text = m.text;
    let textChanged = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = '... [Truncated due to extreme length for UI stability] ...\n' + text.slice(text.length - MAX_TEXT_LENGTH);
      textChanged = true;
    }
    let tools = m.tools;
    let toolsChanged = false;
    if (tools.length > MAX_TOOLS_PER_MESSAGE) {
      tools = tools.slice(tools.length - MAX_TOOLS_PER_MESSAGE);
      toolsChanged = true;
    }
    if (textChanged || toolsChanged) {
      changed = true;
      return { ...m, text, tools };
    }
    return m;
  });
  return changed ? mapped : msgs;
}

export function useAura(settings: Settings) {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMessages((prev) => pruneMessages(prev));
  }, [messages]);

  const clientRef = useRef<ProtocolClient | null>(null);
  // Settings are read inside long-lived callbacks; a ref keeps those current
  // without tearing down the socket every time a preference changes.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Read inside newChat, which must not be rebuilt every time the tool list
  // arrives — a changing identity there would restart the session flow.
  const toolNamesRef = useRef<string[]>([]);

  // The project board. Declared here rather than in the component because the
  // engine announces changes as events, and the event router lives in this
  // hook — a board owned above it could not hear them.
  const board = useBoard(clientRef, connection === 'open');
  // The event router is created once and keys the socket effect, so it must
  // never close over a value that changes. Reading the board through a ref
  // keeps the router stable while still reaching the current board.
  const boardRef = useRef(board);
  boardRef.current = board;

  /** Append text to the streaming assistant message, creating it if needed. */
  const appendDelta = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        const next = prev.slice(0, -1);
        next.push({ ...last, text: last.text + text });
        return next;
      }
      return [...prev, {
        id: `a${Date.now()}`, role: 'assistant', text, tools: [], streaming: true, at: Date.now(),
      }];
    });
  }, []);

  /** Attach a tool event to the in-flight assistant message. */
  const noteTool = useCallback((patch: ToolEvent, mode: 'call' | 'result' | 'blocked') => {
    setMessages((prev) => {
      let list = prev;
      let last = list[list.length - 1];
      if (!last || last.role !== 'assistant' || !last.streaming) {
        last = {
          id: `a${Date.now()}`, role: 'assistant', text: '', tools: [], streaming: true, at: Date.now(),
        };
        list = [...list, last];
      }
      const tools = [...last.tools];
      const at = tools.findIndex((t) => t.id === patch.id);
      if (mode === 'call') {
        if (at < 0) tools.push(patch);
      } else if (at >= 0) {
        tools[at] = { ...tools[at], ...patch };
      } else {
        tools.push(patch);
      }
      return [...list.slice(0, -1), { ...last, tools }];
    });
  }, []);

  const onEvent = useCallback((method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, any>;
    switch (method) {
      case M.turnStarted:
        setBusy(true);
        setError(null);
        break;
      case M.turnDelta:
        if (typeof p.text === 'string') appendDelta(p.text);
        break;
      // Tool events carry no per-call id — the engine keys them by name within
      // a turn (see ToolCallEvent in src/protocol/types.ts), so the result must
      // attach to the most recent unresolved call of that name.
      case M.turnToolCall:
        noteTool({ id: String(p.name ?? 'tool'), name: String(p.name ?? 'tool'), input: p.input }, 'call');
        break;
      case M.turnToolResult:
        noteTool({
          id: String(p.name ?? 'tool'), name: String(p.name ?? 'tool'),
          result: typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? ''),
          elapsedMs: typeof p.elapsedMs === 'number' ? p.elapsedMs : undefined,
        }, 'result');
        break;
      case M.turnToolBlocked:
        noteTool({
          id: String(p.name ?? 'tool'), name: String(p.name ?? 'tool'),
          blocked: String(p.reason ?? 'blocked'),
        }, 'blocked');
        break;
      case M.turnCompleted: {
        setBusy(false);

        setMessages((prev) => {
          const summary = typeof p.summary === 'string' ? p.summary : '';
          const last = prev[prev.length - 1];
          if (last?.streaming) {
            // Some paths emit no deltas at all and deliver the whole answer in
            // `summary`. Falling back to it stops those turns rendering blank.
            return prev.map((m, i) => (i !== prev.length - 1 ? m : {
              ...m, streaming: false, text: m.text.trim() ? m.text : summary,
            }));
          }
          // No assistant message exists at all. The only thing that creates one
          // is a delta or a tool call, and a turn that fails before either —
          // a provider 429, an auth error, a budget stop — produces neither. The
          // summary was then dropped on the floor and the user saw *nothing*
          // come back from their message, with no error and no clue why.
          if (!summary.trim()) return prev;
          return [...prev, {
            id: `a${Date.now()}`, role: 'assistant', text: summary, tools: [],
            at: Date.now(),
            // Reported as an error when the engine says the turn failed, so a
            // provider refusal does not read as Aura's considered answer.
            ...(p.success === false ? { error: summary } : {}),
          }];
        });
        if (p.usage) {
          setUsage({
            inputTokens: Number(p.usage.inputTokens ?? 0),
            outputTokens: Number(p.usage.outputTokens ?? 0),
            costUsd: typeof p.usage.costUsd === 'number' ? p.usage.costUsd : undefined,
          });
        }
        break;
      }
      case M.boardChanged:
        boardRef.current.applyChanged(p);
        break;
      case M.turnError: {
        setBusy(false);
        setError(String(p.message ?? 'turn failed'));

        setMessages((prev) => prev.map((m, i) =>
          i === prev.length - 1 && m.streaming
            ? { ...m, streaming: false, error: String(p.message ?? 'turn failed') }
            : m));
        break;
      }
      default:
        break;
    }
  }, [appendDelta, noteTool]);

  /**
   * The engine asking permission. Held as UI state until the operator answers;
   * the promise the engine is waiting on resolves with their choice, so an
   * unanswered prompt blocks that turn rather than silently allowing it.
   */
  const onRequest = useCallback((method: string, params: unknown) => {
    if (method !== M.approvalRequest) return { decision: 'deny' as const };
    const p = (params ?? {}) as Record<string, any>;
    return new Promise<{ decision: 'allow' | 'deny' }>((resolve) => {
      setApproval({
        tool: String(p.tool || 'tool'),
        tier: Number(p.tier ?? 3),
        // `rendered` is the engine's own one-liner and is always populated;
        // the raw args are the fallback, never the headline.
        detail: typeof p.rendered === 'string' && p.rendered
          ? p.rendered
          : JSON.stringify(p.args ?? {}, null, 2),
        resolve: (allowed) => {
          setApproval(null);
          resolve({ decision: allowed ? 'allow' : 'deny' });
        },
      });
    });
  }, []);

  useEffect(() => {
    const client = new ProtocolClient({ onEvent, onRequest, onState: setConnection });
    clientRef.current = client;
    client.connect();
    return () => { client.close(); clientRef.current = null; };
    // Deliberately mounted once: the callbacks are stable, and reconnecting on
    // every settings change would drop an in-flight turn.
  }, [onEvent, onRequest]);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await clientRef.current?.request<{ sessions?: any[] }>(M.sessionList);
      const list = (res?.sessions ?? []).map((s: any) => ({
        sessionId: String(s.sessionId),
        title: String(s.name || 'Untitled'),
        at: Number(s.createdAt ?? Date.now()),
      }));
      setConversations(list.sort((a, b) => b.at - a.at));
    } catch { /* a listing failure must not blank the UI */ }
  }, []);

  const newChat = useCallback(async (title?: string) => {
    const s = settingsRef.current;
    try {
      const res = await clientRef.current?.request<{ sessionId: string }>(M.sessionCreate, {
        projectRoot: '.',
        ...(s.model ? { model: s.model } : {}),
        ...(s.maxInputTokens ? { maxInputTokens: s.maxInputTokens } : {}),
        name: title,
        // Actually enforced by the engine (see SessionCreateParams.permission).
        permission: s.permission,
        // Only send an allowlist when something is actually switched off:
        // omitting it means "every tool", including any added since.
        ...(s.disabledTools.length > 0 && toolNamesRef.current.length > 0
          ? { allowedTools: toolNamesRef.current.filter((n) => !s.disabledTools.includes(n)) }
          : {}),
      });
      if (res?.sessionId) {
        setSessionId(res.sessionId);
        setMessages([]);
        setUsage(null);
        setError(null);
        void refreshConversations();
      }
      return res?.sessionId ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, [refreshConversations]);

  const openChat = useCallback(async (id: string) => {
    setSessionId(id);
    setError(null);
    try {
      const res = await clientRef.current?.request<{ messages?: any[] }>(M.sessionHistory, {
        sessionId: id,
      });
      setMessages((res?.messages ?? []).map((m: any, i: number) => ({
        id: `h${i}`,
        role: m.role === 'user' ? 'user' : 'assistant',
        text: typeof m.content === 'string' ? m.content : String(m.text ?? ''),
        tools: [],
        at: Number(m.at ?? Date.now()),
      })));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Give a conversation a name. Empty clears it back to the placeholder. */
  const renameChat = useCallback(async (id: string, title: string) => {
    try { await clientRef.current?.request(M.sessionRename, { sessionId: id, name: title }); }
    catch { /* the refresh below re-reads the truth either way */ }
    void refreshConversations();
  }, [refreshConversations]);

  const deleteChat = useCallback(async (id: string) => {
    try { await clientRef.current?.request(M.sessionDestroy, { sessionId: id }); } catch { /* */ }
    if (sessionId === id) { setSessionId(null); setMessages([]); }
    void refreshConversations();
  }, [sessionId, refreshConversations]);

  /**
   * Put a note in the thread that did not come from the engine — a command's
   * answer, or the reason a command could not run. Local only: it is never
   * sent as a turn and never reaches the model.
   */
  const systemNote = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `s${Date.now()}${Math.random()}`, role: 'system', text, tools: [], at: Date.now() },
    ]);
  }, []);

  const send = useCallback(async (
    text: string,
    attachments: Array<{ name: string; type: string; size: number; dataUrl: string }> = [],
  ) => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || busy) return;
    let id = sessionId;
    if (!id) id = await newChat(trimmed.slice(0, 60));
    if (!id) return;

    // Images ride the protocol's `images` field. Everything else is named in
    // the message: the engine reads files with its own tools, so handing it a
    // path it can open beats shipping an opaque blob it cannot inspect.
    const images = attachments.filter((a) => a.type.startsWith('image/')).map((a) => a.dataUrl);
    const others = attachments.filter((a) => !a.type.startsWith('image/'));
    const note = others.length > 0
      ? `\n\n[attached: ${others.map((a) => `${a.name} (${Math.ceil(a.size / 1024)} KB)`).join(', ')}]`
      : '';
    const shown = trimmed
      + (images.length > 0 ? `\n\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
      + note;

    setMessages((prev) => [
      ...prev,
      { id: `u${Date.now()}`, role: 'user', text: shown, tools: [], at: Date.now() },
    ]);
    setBusy(true);
    setError(null);
    try {
      await clientRef.current?.request(M.turnSend, {
        sessionId: id,
        message: trimmed + note,
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }, [busy, sessionId, newChat]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    try { await clientRef.current?.request(M.turnCancel, { sessionId }); } catch { /* */ }
    setBusy(false);
  }, [sessionId]);

  /** Re-ask the last user message, dropping the answer it produced. */
  const regenerate = useCallback(async () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || busy) return;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === lastUser.id);
      return idx >= 0 ? prev.slice(0, idx + 1) : prev;
    });
    setBusy(true);
    try {
      await clientRef.current?.request(M.turnSend, { sessionId, message: lastUser.text });
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }, [messages, busy, sessionId]);

  /**
   * Ask the engine to run a board task.
   *
   * One call, and the engine does the rest: it builds the session from the
   * agent's preset, moves the tile to Execution, runs the turn, and writes the
   * answer back onto the tile.
   *
   * It used to be done here — session.create, turn.send, and a ref remembering
   * which task the turn belonged to. That ref does not survive a page reload or
   * an engine restart, so a tile could sit in Execution for ever with nothing
   * able to move it. Completion has to belong to the side that outlives the
   * browser tab.
   */
  const runTask = useCallback(async (task: BoardTask) => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    try {
      const activeModel = settingsRef.current.model;
      const res = await client.request<{ sessionId: string }>(M.boardRun, {
        id: task.id,
        model: activeModel || task.model || undefined,
        // The operator's own level. The engine caps it by the agent's preset,
        // so a read-only reviewer stays read-only, but "auto" stops the
        // prompting for the agents that can be trusted with it.
        permission: settingsRef.current.permission,
      });
      // Follow the run in the chat view, so the tool calls are visible while it
      // works rather than only the answer at the end.
      // Follow the newest run in the chat view so its tool calls are visible
      // while it works. Deliberately does NOT set `busy`: a board task runs in
      // its own session, so the chat's session is not busy — and marking it so
      // was what stopped a second task from being started at all.
      setSessionId(res.sessionId);
      setMessages([{
        id: `u${Date.now()}`, role: 'user',
        text: task.notes?.trim() ? `${task.title}\n\n${task.notes}` : task.title,
        tools: [], at: Date.now(),
      }]);
      void refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshConversations]);

  useEffect(() => {
    if (connection !== 'open') return;
    void refreshConversations();
    clientRef.current?.request<{ tools?: any[] }>(M.toolsList)
      .then((r) => setTools((r?.tools ?? []).map((t: any) => ({
        name: String(t.name ?? t),
        description: String(t.description ?? ''),
      }))))
      .catch(() => { /* tool listing is informational */ });
  }, [connection, refreshConversations]);

  toolNamesRef.current = tools.map((t) => t.name);

  return useMemo(() => ({
    connection, conversations, sessionId, messages, busy, approval, usage, tools, error,
    send, stop, regenerate, newChat, openChat, deleteChat, renameChat, refreshConversations, systemNote,
    board, runTask,
  }), [
    connection, conversations, sessionId, messages, busy, approval, usage, tools, error,
    send, stop, regenerate, newChat, openChat, deleteChat, renameChat, refreshConversations, systemNote,
    board, runTask,
  ]);
}

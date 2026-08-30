import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { M, type ProtocolClient } from '../lib/protocol';
import { authFetch } from '../lib/auth';

/**
 * The project board, over the protocol.
 *
 * The engine owns the tasks — they live in a file per project, not in this
 * browser — so every mutation is a round trip and the answer of record is the
 * `board.changed` event, not local state. Two windows open on the same project
 * therefore agree, and a reload loses nothing.
 *
 * The optimism you would normally add here is deliberately absent. A tile that
 * jumps to the next column and then snaps back because the write failed is
 * worse than one that moves a beat later: this board dispatches real work, so
 * a card in `execution` has to mean the engine agrees it is there.
 *
 * The client arrives as a ref because the socket is created after first render
 * and replaced on reconnect. Capturing the value instead would leave this hook
 * holding a dead socket for the rest of the session.
 */

export const BOARD_COLUMNS = ['planning', 'preparation', 'execution', 'finished'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export interface BoardAttachment {
  name: string;
  type: string;
  size: number;
  /** Absolute path on the machine running the engine. */
  path: string;
}

export interface WorkflowStepNode {
  id: string;
  name: string;
  type: 'tool' | 'llm' | 'gate' | 'condition' | 'verify';
  tool?: string;
  desc?: string;
  x: number;
  y: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowDef {
  nodes: WorkflowStepNode[];
  edges: WorkflowEdge[];
}

export interface BoardTask {
  id: string;
  title: string;
  notes?: string;
  column: BoardColumn;
  agent: string;
  model?: string;
  sessionId?: string;
  result?: string;
  failed?: boolean;
  attachments?: BoardAttachment[];
  priority?: 'normal' | 'urgent';
  attention?: boolean;
  linkedTo?: string;
  order: number;
  tools?: string[];
  gated?: boolean;
  workflow?: WorkflowDef;
  swarm?: {
    strategy: string;
    agents: Array<{ id: string; name: string; role: string; icon: string }>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  title: string;
  notes?: string;
  column?: BoardColumn;
  agent?: string;
  model?: string;
  tools?: string[];
  gated?: boolean;
  workflow?: WorkflowDef;
  swarm?: {
    strategy: string;
    agents: Array<{ id: string; name: string; role: string; icon: string }>;
  };
}

export interface AgentPreset {
  id: string;
  label: string;
  description: string;
  permission: 'read-only' | 'normal' | 'auto';
  allowedTools?: string[];
}

export interface BoardApi {
  tasks: BoardTask[];
  /** Agent names the engine will actually accept, straight from the engine. */
  agents: string[];
  /** What each agent may touch — the engine's own copy, never a local guess. */
  presets: AgentPreset[];
  error: string | null;
  /** Resolves with the created task, or null if the engine refused it. */
  add: (patch: NewTask) => Promise<BoardTask | null>;
  update: (id: string, patch: Partial<BoardTask>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Fold in a `board.changed` event. Called by useAura's event router. */
  applyChanged: (params: unknown) => void;
  /** Upload a file or image onto a task. Resolves when the engine has it. */
  attach: (taskId: string, file: File) => Promise<void>;
}

/** The default agent list, used only until the engine answers with its own. */
const FALLBACK_AGENTS = ['aura', 'researcher', 'coder', 'reviewer', 'planner'];

export function useBoard(
  clientRef: MutableRefObject<ProtocolClient | null>,
  connected: boolean,
): BoardApi {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [agents, setAgents] = useState<string[]>(FALLBACK_AGENTS);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const res = await client.request<{
        tasks: BoardTask[]; agents?: string[]; presets?: AgentPreset[];
      }>(M.boardGet, {});
      setTasks(res.tasks ?? []);
      // The engine's lists are authoritative, so an agent added there shows up
      // in the picker without a matching frontend release — and dispatch uses
      // the engine's own permission and tool set rather than a copy that can
      // drift out of step with it.
      if (res.agents?.length) setAgents(res.agents);
      if (res.presets?.length) setPresets(res.presets);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load the board');
    }
  }, [clientRef]);

  // Load once the socket is up, and again after a reconnect — a board edited
  // elsewhere while this window was offline would otherwise stay stale until
  // the next mutation.
  useEffect(() => { if (connected) void refresh(); }, [connected, refresh]);

  const call = useCallback(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const client = clientRef.current;
    if (!client) return null;
    try {
      const res = await client.request(method, params);
      setError(null);
      return res;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the board rejected that change');
      // Re-read rather than guess: after a failed write the screen and the file
      // disagree, and the file is the one that is right.
      void refresh();
      return null;
    }
  }, [clientRef, refresh]);

  const applyChanged = useCallback((params: unknown) => {
    const p = (params ?? {}) as { tasks?: unknown };
    if (Array.isArray(p.tasks)) setTasks(p.tasks as BoardTask[]);
  }, []);

  /** Resolves with the created task so a caller can act on it — run it, for
   *  instance — without re-finding it by title. Null if the write failed. */
  const add = useCallback(async (patch: NewTask): Promise<BoardTask | null> => {
    const res = (await call(M.boardAdd, { ...patch })) as { task?: BoardTask } | null;
    return res?.task ?? null;
  }, [call]);
  const update = useCallback(
    async (id: string, patch: Partial<BoardTask>) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      await call(M.boardUpdate, { id, ...patch });
    },
    [call],
  );
  const remove = useCallback(async (id: string): Promise<void> => { await call(M.boardRemove, { id }); }, [call]);

  /**
   * Send a picked file to the engine, which writes it beside the board and
   * puts the path on the task.
   */
  const attach = useCallback(async (taskId: string, file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
        reader.readAsDataURL(file);
      });
      const res = await authFetch('/api/board/attach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, name: file.name, type: file.type, dataUrl }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not attach that file');
    }
  }, []);

  // Memoised, and not as a micro-optimisation. useAura's event router closes
  // over this object, and the socket effect is keyed on that router's
  // identity — so returning a fresh object literal each render tore the
  // WebSocket down and rebuilt it on every render, which froze the tab and
  // showed as a permanent "Disconnected".
  return useMemo(() => ({
    tasks, agents, presets, error, refresh, applyChanged, add, update, remove, attach,
  }), [tasks, agents, presets, error, refresh, applyChanged, add, update, remove, attach]);
}

/**
 * Tasks of one column, in display order.
 *
 * The first three keep the arrangement the operator dragged them into.
 * `finished` is a record of what happened and is ordered by when — that is not
 * theirs to rearrange, so dropping into it does nothing.
 */
export function tasksIn(tasks: BoardTask[], column: BoardColumn): BoardTask[] {
  const of = tasks.filter((t) => t.column === column);
  if (column === 'finished') return of.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return of.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

/** Column order is fixed only where the record must be. */
export function isOrderable(column: BoardColumn): boolean {
  return column !== 'finished';
}

/** The order value that drops a task between two neighbours. */
export function orderBetween(before?: BoardTask, after?: BoardTask): number {
  if (!before && !after) return 1000;
  if (!before) return after!.order - 1000;
  if (!after) return before.order + 1000;
  return (before.order + after.order) / 2;
}

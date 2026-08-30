/**
 * The project board — tasks a human plans and an agent runs.
 *
 * Aura had a Kanban subsystem once and it was deleted as dead code: nothing
 * wrote to it and nothing read from it. The difference here is that a tile is
 * not a note *about* work, it is the work — moving one into `execution`
 * dispatches it to the assigned agent, and the answer comes back onto the
 * tile. A board that cannot do that is decoration, and decoration is what got
 * deleted last time.
 */

/** The four stages a task moves through. */
export const BOARD_COLUMNS = ['planning', 'preparation', 'execution', 'finished'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/**
 * Who runs the task.
 *
 * These are the specialists that actually exist in src/orchestration/
 * specialists.ts, not a wish-list: `runSpecialist` dispatches on exactly
 * researcher / coder / reviewer / planner, and `aura` means the ordinary
 * single-agent loop. Offering an agent the engine cannot run would produce a
 * tile that fails at dispatch for no visible reason.
 */
export const BOARD_AGENTS = ['aura', 'researcher', 'coder', 'reviewer', 'planner'] as const;
export type BoardAgent = (typeof BOARD_AGENTS)[number];

export function isBoardColumn(v: unknown): v is BoardColumn {
  return typeof v === 'string' && (BOARD_COLUMNS as readonly string[]).includes(v);
}

export function isBoardAgent(v: unknown): v is BoardAgent {
  return typeof v === 'string' && (BOARD_AGENTS as readonly string[]).includes(v);
}

/**
 * A file or image attached to a task.
 *
 * Stored as a real file on disk and referenced by absolute path — never as
 * base64 inside the board. Two reasons, and both matter: a few screenshots
 * would turn a small JSON file into megabytes that are re-read and re-written
 * on every single edit, and the agent already has `read_file` and `image_read`.
 * Handing it a path it can open beats shipping it an opaque blob it cannot
 * inspect, which is the same call the chat composer makes for its own
 * attachments.
 */
export interface BoardAttachment {
  name: string;
  /** MIME type as the browser reported it. */
  type: string;
  size: number;
  /** Absolute path on the machine running the engine. */
  path: string;
}

/**
 * A pipeline attached to a task: the steps it runs and how they connect.
 *
 * Built in the Canvas graph editor and saved onto a task. Positions are kept
 * because the graph is edited visually — dropping them would re-flow the
 * layout into something the author did not arrange every time it reopened.
 */
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

const WORKFLOW_NODE_TYPES = ['tool', 'llm', 'gate', 'condition', 'verify'] as const;

/**
 * Validate a workflow arriving from a client.
 *
 * It reaches the board file and is read back on every load, so a malformed one
 * is a persistent break rather than a single bad request. Unknown node types
 * and edges pointing at absent nodes are rejected here instead of failing
 * later at run time.
 */
export function isWorkflowDef(v: unknown): v is WorkflowDef {
  if (!v || typeof v !== 'object') return false;
  const d = v as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return false;

  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (!n || typeof n !== 'object') return false;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id) return false;
    if (typeof node.name !== 'string') return false;
    if (typeof node.x !== 'number' || typeof node.y !== 'number') return false;
    if (!(WORKFLOW_NODE_TYPES as readonly unknown[]).includes(node.type)) return false;
    if (node.tool !== undefined && typeof node.tool !== 'string') return false;
    if (node.desc !== undefined && typeof node.desc !== 'string') return false;
    ids.add(node.id);
  }

  for (const e of d.edges) {
    if (!e || typeof e !== 'object') return false;
    const edge = e as Record<string, unknown>;
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') return false;
    // An edge to a node that is not here would draw a wire into nothing.
    if (!ids.has(edge.from) || !ids.has(edge.to)) return false;
  }
  return true;
}

export interface BoardTask {
  id: string;
  /** One-line summary — the tile face. */
  title: string;
  /** The task as it will be sent to the agent, when longer than the title. */
  notes?: string;
  column: BoardColumn;
  agent: BoardAgent;
  /**
   * Model override for this task, e.g. 'gemini/gemini-2.5-flash'. Empty means
   * the session's model. Per-tile so cheap work can be routed to a cheap
   * model without changing the session for everything else.
   */
  model?: string;
  /** Set when the task has been dispatched — the session it is running in. */
  sessionId?: string;
  /** The agent's answer, once it finishes. */
  result?: string;
  /** True when the run failed; `result` then holds the error. */
  failed?: boolean;
  /** Files and images the agent should look at. */
  attachments?: BoardAttachment[];
  /** File paths modified or generated by the agent during task execution. */
  files?: string[];
  /** 'urgent' paints the tile red. Priority is the operator's judgement, not
   *  something inferred — nothing here decides for them what is urgent. */
  priority?: 'normal' | 'urgent';
  /**
   * The task is waiting on a person.
   *
   * Set when a run stops for an approval, and clearable by hand. It is a
   * separate flag from `failed` because "it needs you" and "it went wrong" ask
   * for different things, and a board that renders them the same trains people
   * to ignore both.
   */
  attention?: boolean;
  /**
   * The task this one pulls in when it finishes — a workflow, one link at a
   * time. Chains rather than a graph: a list of tasks that follow one another
   * is what people actually build, and it cannot deadlock the way arbitrary
   * dependencies can.
   */
  linkedTo?: string;
  /**
   * The pipeline this task carries, if it was built in the graph editor.
   *
   * Persisted with the task: it was previously held only in the browser, so
   * editing the steps appeared to work and was gone on reload.
   */
  workflow?: WorkflowDef;
  /**
   * The task is waiting in the queue because another write-capable task is running.
   */
  waiting?: boolean;
  /** Ordering within a column. Sparse, so a move never rewrites its neighbours. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardState {
  /** Schema version, so a later shape change can migrate rather than discard. */
  version: 1;
  tasks: BoardTask[];
}

export const EMPTY_BOARD: BoardState = { version: 1, tasks: [] };

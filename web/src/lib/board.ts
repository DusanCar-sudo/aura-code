/**
 * The Kanban board, derived from the conversation rather than stored.
 *
 * Aura had a Kanban subsystem once — 2855 lines of engine, pipeline, server
 * and MCP tool — and it was deleted in 3560c77 for the plainest possible
 * reason: "no call sites". It modelled a board nothing wrote to, so nothing
 * read from it either. Rebuilding that would repeat the mistake.
 *
 * So this board stores nothing. It is a pure projection of the work the client
 * already has in `messages`, and the columns are the *states that work passes
 * through* — planned → ready → execution → result — rather than a filing
 * system for tool categories. A card moves left to right as the run proceeds,
 * which is what makes it a board and not a table.
 *
 * The consequence worth stating: this is a board you *watch*, not one you
 * *edit*. Dragging a card would be asking the UI to lie about what happened.
 */

import type { Message, ToolEvent } from '../hooks/useAura';

export const COLUMNS = ['planned', 'ready', 'execution', 'result'] as const;
export type Column = (typeof COLUMNS)[number];

/** How a piece of work ended, for the badge. Independent of which column it
 *  sits in: everything in `result` is one of done / blocked / failed. */
export type CardOutcome = 'pending' | 'running' | 'done' | 'blocked' | 'failed';

export interface BoardCard {
  id: string;
  /** Tool name, or 'task' / 'answer' / 'error' for the turn itself. */
  title: string;
  /** The most identifying argument — a path, a command, a query. */
  detail?: string;
  column: Column;
  outcome: CardOutcome;
  elapsedMs?: number;
  /** 1-based turn number, so a card can be traced back to one. */
  turn: number;
  /** The turn's own card rather than a tool call — styled differently. */
  isTask?: boolean;
}

export interface Board {
  columns: Array<{ column: Column; cards: BoardCard[] }>;
  /** Total cards, so an empty board can say so rather than render four voids. */
  total: number;
}

/**
 * The argument worth showing on the card face.
 *
 * One value, chosen by what identifies the call: a path for file tools, the
 * command for a shell, the query for a search. Falls back to nothing rather
 * than dumping JSON — a card is a glance, and an unreadable card is worse than
 * a bare one.
 */
export function detailFor(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ['path', 'command', 'query', 'pattern', 'url', 'file', 'task', 'action']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Where a tool call sits, and how it is doing.
 *
 * `ready` is the one state the board cannot infer from the call alone: a tool
 * waiting on the permission gate looks exactly like one that is running. The
 * pending approval is therefore passed in, and the call it names is the one
 * that has been *prepared but not authorised* — which is precisely "ready to
 * execute".
 */
function placeTool(
  tool: ToolEvent,
  turnLive: boolean,
  awaitingApproval: string | null,
): { column: Column; outcome: CardOutcome } {
  if (tool.blocked) return { column: 'result', outcome: 'blocked' };
  if (tool.result !== undefined) return { column: 'result', outcome: 'done' };

  // No result yet. If the turn is over, it never arrived — the call did not
  // finish, and parking it in `execution` forever would be a lie the board
  // never corrects.
  if (!turnLive) return { column: 'result', outcome: 'failed' };

  if (awaitingApproval && awaitingApproval === tool.name) {
    return { column: 'ready', outcome: 'pending' };
  }
  return { column: 'execution', outcome: 'running' };
}

/**
 * Project the conversation onto the board. Pure — same input, same board.
 *
 * `awaitingApproval` is the name of the tool the operator is currently being
 * asked about, or null. It is the only signal that separates "ready" from
 * "running", so without it that column stays empty and nothing is misreported.
 */
export function buildBoard(messages: Message[], awaitingApproval: string | null = null): Board {
  const cards: BoardCard[] = [];
  let turn = 0;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    turn += 1;

    const live = message.streaming === true;

    // The turn's own card. It is one card in four states across the run: it
    // starts planned, moves to execution once the agent actually does
    // something, and lands in result as the answer. Watching it cross the
    // board is the point of the board.
    const done = !live;
    cards.push({
      id: `${message.id}:task`,
      title: message.error ? 'error' : done ? 'answer' : 'task',
      detail: message.error ?? (done ? firstLine(message.text) : undefined),
      column: done ? 'result' : message.tools.length ? 'execution' : 'planned',
      outcome: message.error ? 'failed' : done ? 'done' : message.tools.length ? 'running' : 'pending',
      turn,
      isTask: true,
    });

    for (const [i, tool] of message.tools.entries()) {
      const { column, outcome } = placeTool(tool, live, awaitingApproval);
      cards.push({
        id: `${message.id}:${i}:${tool.name}`,
        title: tool.name,
        detail: detailFor(tool.input),
        column,
        outcome,
        elapsedMs: tool.elapsedMs,
        turn,
      });
    }
  }

  return {
    columns: COLUMNS.map((column) => ({ column, cards: cards.filter((c) => c.column === column) })),
    total: cards.length,
  };
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split('\n').find((l) => l.trim());
  if (!line) return undefined;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Kanban MCP Tool Wrapper
 *
 * Exposes the kanban server's POST /api/move as an MCP tool definition.
 * Any agent (Aura, AgentMesh, Claude, etc.) can use this to move cards
 * without knowing the HTTP API directly.
 *
 * Usage:
 *   import { kanbanMoveTool } from './mcp-tool.js';
 *   // Register kanbanMoveTool in your MCP tool registry
 *
 * The tool calls the standalone kanban server at KANBAN_URL (default: localhost:3456).
 */

import type { KanbanCard } from './types.js';

// ── Configuration ────────────────────────────────────────────────────────────

const KANBAN_URL = process.env.KANBAN_URL || 'http://localhost:3456';

// ── MCP Tool Definition ──────────────────────────────────────────────────────

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const kanbanMoveTool: MCPToolDef = {
  name: 'kanban_move_card',
  description: 'Move a kanban card to a new column. Call this when you (the agent) start or finish work on a task.',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: {
        type: 'string',
        description: 'The card ID to move (e.g. "kb-a1b2c3d4")',
      },
      column: {
        type: 'string',
        description: 'Target column: backlog, todo, in-progress, review, done',
      },
      reason: {
        type: 'string',
        description: 'Short reason for the move (1-2 words is fine)',
      },
    },
    required: ['cardId', 'column'],
  },
};

// ── Tool Handler ─────────────────────────────────────────────────────────────

export interface MoveResult {
  ok: boolean;
  card?: {
    id: string;
    title: string;
    column: string;
    updatedAt: string;
  };
  error?: string;
}

export async function handleKanbanMove(args: {
  cardId: string;
  column: string;
  reason?: string;
}): Promise<MoveResult> {
  try {
    const response = await fetch(`${KANBAN_URL}/api/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId: args.cardId,
        column: args.column,
        reason: args.reason || '',
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { ok: false, error: err.error || `HTTP ${response.status}` };
    }

    return await response.json();
  } catch (err) {
    return { ok: false, error: `Cannot reach kanban server at ${KANBAN_URL}: ${err}` };
  }
}

// ── Board state tool (for agents to read current state) ──────────────────────

export const kanbanBoardTool: MCPToolDef = {
  name: 'kanban_get_board',
  description: 'Get the full kanban board state — all columns and cards.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function handleKanbanBoard(): Promise<{
  columns: string[];
  cards: KanbanCard[];
}> {
  const response = await fetch(`${KANBAN_URL}/api/board`);
  if (!response.ok) {
    throw new Error(`Kanban server error: ${response.status}`);
  }
  return response.json();
}

/**
 * Standalone Kanban Server
 *
 * Agent-agnostic live kanban board. Any agent (Aura, AgentMesh, etc.) can
 * call POST /api/move to update card state. The GUI polls GET /api/board
 * or subscribes via WebSocket at /api/events.
 *
 * Storage: ~/.aura/kanban.json (reuses engine.ts)
 *
 * Usage:
 *   npx ts-node src/kanban/standalone-server.ts [--port 3456]
 */

import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import {
  loadBoard,
  moveCard,
  addCard,
  getCard,
  listCards,
  stats,
} from './engine.js';
import type { KanbanCard } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface MoveRequest {
  cardId: string;
  column: string;
  reason?: string;
}

interface CreateCardRequest {
  title: string;
  column?: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

interface WsEvent {
  type: 'card_moved' | 'card_created' | 'card_deleted';
  cardId?: string;
  from?: string;
  to?: string;
  reason?: string;
  card?: KanbanCard;
  timestamp: string;
}

// ── Server ───────────────────────────────────────────────────────────────────

export interface StandaloneKanbanOptions {
  port: number;
}

export function createStandaloneKanbanApp() {
  const app = express();
  app.use(express.json());

  // WebSocket clients for live events
  const wsClients = new Set<WebSocket>();

  function broadcast(event: WsEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // ── CORS (allow any agent/GUI to connect) ──────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    next();
  });

  // ── GET /api/board — full board state ──────────────────────────────────
  app.get('/api/board', (_req, res) => {
    const board = loadBoard();
    res.json(board);
  });

  // ── GET /api/cards — list cards (optionally filtered by column) ────────
  app.get('/api/cards', (req, res) => {
    const column = req.query.column as string | undefined;
    const cards = listCards(column);
    res.json(cards);
  });

  // ── GET /api/card/:id — single card ────────────────────────────────────
  app.get('/api/card/:id', (req, res) => {
    const card = getCard(req.params.id);
    if (!card) {
      res.status(404).json({ ok: false, error: `Card not found: ${req.params.id}` });
      return;
    }
    res.json(card);
  });

  // ── POST /api/move — agent posts a card move (core endpoint) ───────────
  app.post('/api/move', (req, res) => {
    const { cardId, column, reason } = req.body as MoveRequest;

    if (!cardId || !column) {
      res.status(400).json({ ok: false, error: 'Missing required fields: cardId, column' });
      return;
    }

    const card = getCard(cardId);
    if (!card) {
      res.status(404).json({ ok: false, error: `Card not found: ${cardId}` });
      return;
    }

    const from = card.column;
    const updated = moveCard(cardId, column);
    if (!updated) {
      res.status(404).json({ ok: false, error: `Card not found: ${cardId}` });
      return;
    }

    // Broadcast live event
    broadcast({
      type: 'card_moved',
      cardId,
      from,
      to: column,
      reason: reason || '',
      card: updated,
      timestamp: new Date().toISOString(),
    });

    res.json({
      ok: true,
      card: {
        id: updated.id,
        title: updated.title,
        column: updated.column,
        updatedAt: updated.updatedAt,
      },
    });
  });

  // ── POST /api/card — create a new card ─────────────────────────────────
  app.post('/api/card', (req, res) => {
    const { title, column, description, priority, tags } = req.body as CreateCardRequest;

    if (!title) {
      res.status(400).json({ ok: false, error: 'Missing required field: title' });
      return;
    }

    const card = addCard(title, column || 'backlog', { description, priority, tags });

    broadcast({
      type: 'card_created',
      cardId: card.id,
      card,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ ok: true, card });
  });

  // ── DELETE /api/card/:id — delete a card ───────────────────────────────
  app.delete('/api/card/:id', (req, res) => {
    const { id } = req.params;
    const card = getCard(id);
    if (!card) {
      res.status(404).json({ ok: false, error: `Card not found: ${id}` });
      return;
    }

    const { deleteCard } = require('./engine.js');
    deleteCard(id);

    broadcast({
      type: 'card_deleted',
      cardId: id,
      timestamp: new Date().toISOString(),
    });

    res.json({ ok: true });
  });

  // ── GET /api/stats — board statistics ──────────────────────────────────
  app.get('/api/stats', (_req, res) => {
    res.json(stats());
  });

  // ── GET /api/health — health check ─────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', storage: '~/.aura/kanban.json' });
  });

  return { app, broadcast, wsClients };
}

export async function startStandaloneKanbanServer(
  opts: StandaloneKanbanOptions = { port: 3456 },
): Promise<http.Server> {
  const { app, wsClients } = createStandaloneKanbanApp();
  const server = http.createServer(app);

  // WebSocket server for live events
  const wss = new WebSocketServer({ server, path: '/api/events' });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => { wsClients.delete(ws); });
  });

  return new Promise((resolve) => {
    server.listen(opts.port, () => {
      console.log(`[kanban] Standalone kanban server listening on http://localhost:${opts.port}`);
      console.log(`[kanban]   API:    http://localhost:${opts.port}/api/board`);
      console.log(`[kanban]   Move:   POST http://localhost:${opts.port}/api/move`);
      console.log(`[kanban]   Events: ws://localhost:${opts.port}/api/events`);
      resolve(server);
    });
  });
}

// ── CLI entry point ──────────────────────────────────────────────────────────

// When run directly as a script
const isMainModule = process.argv[1]?.endsWith('standalone-server.ts');
if (isMainModule) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3456;

  startStandaloneKanbanServer({ port }).catch((err) => {
    console.error('[kanban] Failed to start server:', err);
    process.exit(1);
  });
}

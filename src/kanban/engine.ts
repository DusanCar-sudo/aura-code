/**
 * Aura Kanban — engine (JSON-file backed, zero external deps)
 *
 * Storage: ~/.aura/kanban.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { KanbanCard, KanbanBoard, CardPriority } from './types.js';
import { DEFAULT_COLUMNS } from './types.js';

// ── Storage path ─────────────────────────────────────────────────────────────

const STORE_DIR = path.join(process.env.HOME ?? '~', '.aura');
const STORE_FILE = path.join(STORE_DIR, 'kanban.json');

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

// ── Load / Save ──────────────────────────────────────────────────────────────

export function loadBoard(): KanbanBoard {
  if (!fs.existsSync(STORE_FILE)) {
    return { columns: [...DEFAULT_COLUMNS], cards: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Partial<KanbanBoard>;
    return {
      columns: raw.columns ?? [...DEFAULT_COLUMNS],
      cards: raw.cards ?? [],
    };
  } catch {
    return { columns: [...DEFAULT_COLUMNS], cards: [] };
  }
}

export function saveBoard(board: KanbanBoard): void {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(board, null, 2) + '\n', 'utf-8');
}

// ── ID generation ────────────────────────────────────────────────────────────

function newId(): string {
  return `kb-${crypto.randomBytes(4).toString('hex')}`;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function addCard(
  title: string,
  column = 'backlog',
  opts: { description?: string; priority?: CardPriority; tags?: string[] } = {},
): KanbanCard {
  const board = loadBoard();
  const now = new Date().toISOString();
  const card: KanbanCard = {
    id: newId(),
    title,
    description: opts.description,
    column,
    priority: opts.priority ?? 'medium',
    tags: opts.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  board.cards.push(card);
  saveBoard(board);
  return card;
}

export function moveCard(id: string, targetColumn: string): KanbanCard | null {
  const board = loadBoard();
  const card = board.cards.find(c => c.id === id || c.id.endsWith(id));
  if (!card) return null;
  const prev = card.column;
  card.column = targetColumn;
  card.updatedAt = new Date().toISOString();
  if (targetColumn === 'done' && !card.completedAt) {
    card.completedAt = new Date().toISOString();
  } else if (targetColumn !== 'done') {
    delete card.completedAt;
  }
  saveBoard(board);
  return card;
}

export function updateCard(
  id: string,
  patch: Partial<Pick<KanbanCard, 'title' | 'description' | 'priority' | 'tags'>>,
): KanbanCard | null {
  const board = loadBoard();
  const card = board.cards.find(c => c.id === id || c.id.endsWith(id));
  if (!card) return null;
  if (patch.title !== undefined) card.title = patch.title;
  if (patch.description !== undefined) card.description = patch.description;
  if (patch.priority !== undefined) card.priority = patch.priority;
  if (patch.tags !== undefined) card.tags = patch.tags;
  card.updatedAt = new Date().toISOString();
  saveBoard(board);
  return card;
}

export function deleteCard(id: string): boolean {
  const board = loadBoard();
  const idx = board.cards.findIndex(c => c.id === id || c.id.endsWith(id));
  if (idx === -1) return false;
  board.cards.splice(idx, 1);
  saveBoard(board);
  return true;
}

export function getCard(id: string): KanbanCard | null {
  const board = loadBoard();
  return board.cards.find(c => c.id === id || c.id.endsWith(id)) ?? null;
}

export function listCards(column?: string): KanbanCard[] {
  const board = loadBoard();
  if (column) return board.cards.filter(c => c.column === column);
  return board.cards;
}

export function clearBoard(): number {
  const board = loadBoard();
  const count = board.cards.length;
  board.cards = [];
  saveBoard(board);
  return count;
}

export function addColumn(name: string): boolean {
  const board = loadBoard();
  if (board.columns.includes(name)) return false;
  board.columns.push(name);
  saveBoard(board);
  return true;
}

export function removeColumn(name: string, moveCardsTo?: string): number {
  const board = loadBoard();
  const idx = board.columns.indexOf(name);
  if (idx === -1) return 0;
  board.columns.splice(idx, 1);
  let moved = 0;
  if (moveCardsTo) {
    for (const card of board.cards) {
      if (card.column === name) {
        card.column = moveCardsTo;
        moved++;
      }
    }
  } else {
    moved = board.cards.filter(c => c.column === name).length;
    board.cards = board.cards.filter(c => c.column !== name);
  }
  saveBoard(board);
  return moved;
}

export function stats(): { total: number; byColumn: Record<string, number>; byPriority: Record<CardPriority, number> } {
  const board = loadBoard();
  const byColumn: Record<string, number> = {};
  const byPriority: Record<CardPriority, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const col of board.columns) byColumn[col] = 0;
  for (const card of board.cards) {
    byColumn[card.column] = (byColumn[card.column] ?? 0) + 1;
    byPriority[card.priority]++;
  }
  return { total: board.cards.length, byColumn, byPriority };
}

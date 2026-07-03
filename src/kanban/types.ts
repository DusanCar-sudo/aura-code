/**
 * Aura Kanban — types
 */

export type CardPriority = 'low' | 'medium' | 'high' | 'critical';

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  column: string;
  priority: CardPriority;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type KanbanColumns = Record<string, KanbanCard[]>;

export interface KanbanBoard {
  columns: string[];
  cards: KanbanCard[];
}

export const DEFAULT_COLUMNS = ['backlog', 'todo', 'in-progress', 'review', 'done'] as const;

export const PRIORITY_ORDER: Record<CardPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

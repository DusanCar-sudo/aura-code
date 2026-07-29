import type { ToolDefinition } from '../providers/types.js';
import {
  addEpisode, searchEpisodes, recentEpisodes, deleteEpisode,
} from '../agent/episodic-memory.js';

// ─────────────────────────────────────────────────────────────────────────────
// Recall — search what happened, as opposed to what is known
// ─────────────────────────────────────────────────────────────────────────────

export interface RecallInput {
  action: 'search' | 'recent' | 'add' | 'forget';
  query?: string;
  text?: string;
  title?: string;
  kind?: string;
  tags?: string[];
  id?: string;
  limit?: number;
}

export const RECALL_DEFINITION: ToolDefinition = {
  name: 'recall',
  description:
    'Search episodic memory — voice memos, brainstorms and notes the user recorded, ' +
    'in the order they happened. Use when the user refers to something they said, ' +
    'thought or recorded before ("that idea I had", "what did I say about X", ' +
    '"the memo about the app"), or when starting work that might already have been ' +
    'discussed. Different from `memory`, which stores settled facts by key; this is ' +
    'for recalling moments you cannot name a key for. ' +
    'Actions: search (by words), recent (latest), add (record one), forget (by id).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'search, recent, add, or forget' },
      query:  { type: 'string', description: 'Words to search for (action=search)' },
      text:   { type: 'string', description: 'Content to record (action=add)' },
      title:  { type: 'string', description: 'Optional short label (action=add)' },
      kind:   { type: 'string', description: 'Origin: memo, note, decision (action=add, default note)' },
      tags:   { type: 'array', items: { type: 'string' }, description: 'Optional tags (action=add)' },
      id:     { type: 'string', description: 'Episode id (action=forget)' },
      limit:  { type: 'number', description: 'Max results (default 8)' },
    },
    required: ['action'],
  },
};

export function recallTool(input: RecallInput): string {
  switch (input.action) {
    case 'search': {
      const query = (input.query ?? '').trim();
      if (!query) return 'Error: search needs a query.';
      const hits = searchEpisodes(query, input.limit ?? 8);
      if (hits.length === 0) {
        // Said plainly, so the model reports "nothing recorded" rather than
        // inventing a plausible memory to fill the gap.
        return `No episodes match "${query}". Nothing was recorded about this.`;
      }
      return [
        `${hits.length} episode${hits.length === 1 ? '' : 's'} matching "${query}":`,
        '',
        ...hits.map(h => [
          `[${h.id}] ${h.title}`,
          `  ${formatWhen(h.at)} · ${h.kind}${h.tags.length ? ' · ' + h.tags.join(', ') : ''}`,
          `  ${h.excerpt.replace(/\n+/g, ' ')}`,
        ].join('\n')),
      ].join('\n');
    }

    case 'recent': {
      const eps = recentEpisodes(input.limit ?? 10);
      if (eps.length === 0) return 'No episodes recorded yet.';
      return [
        `${eps.length} most recent:`,
        '',
        ...eps.map(e => `[${e.id}] ${formatWhen(e.at)} · ${e.kind} · ${e.title}`),
      ].join('\n');
    }

    case 'add': {
      const text = (input.text ?? '').trim();
      if (!text) return 'Error: add needs text.';
      const ep = addEpisode({
        kind: input.kind ?? 'note',
        title: input.title,
        text,
        tags: input.tags,
      });
      return `Recorded episode [${ep.id}]: ${ep.title}`;
    }

    case 'forget': {
      if (!input.id) return 'Error: forget needs an id.';
      return deleteEpisode(input.id)
        ? `Forgotten [${input.id}].`
        : `No episode with id ${input.id}.`;
    }

    default:
      return `Error: unknown action "${String(input.action)}". Use search, recent, add, or forget.`;
  }
}

/** Relative where it helps, absolute where it does not. */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

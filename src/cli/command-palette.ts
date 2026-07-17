/**
 * Command palette — Ctrl+P opens a fuzzy-searchable list of all
 * :commands. Inspired by OpenCode's Ctrl+P palette.
 *
 * Renders an overlay panel at the bottom of the screen (above the
 * input box in bottom-input layout). User types to filter, arrow
 * keys to navigate, Enter to execute, Esc to cancel.
 */
import chalk from 'chalk';
import { TEXT_HEX, TEXT_DIM_HEX, RUBY_ACCENT } from './diamond.js';

const TEXT = chalk.hex(TEXT_HEX);
const TEXT_DIM = chalk.hex(TEXT_DIM_HEX);
const RUBY = RUBY_ACCENT;
const HIGHLIGHT = chalk.hex('#cc785c');

export interface PaletteCommand {
  id: string;       // e.g. ":model"
  label: string;    // e.g. "Switch model"
  description: string; // e.g. "Interactive model selector"
  category: string; // e.g. "Model / API"
}

/**
 * All commands available in the palette. Derived from help-data.ts
 * but kept as a static list here to avoid circular imports.
 */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  // Session
  { id: ':id', label: 'Show session ID', description: 'Current chat ID', category: 'Session' },
  { id: ':sessions', label: 'List sessions', description: 'All saved sessions', category: 'Session' },
  { id: ':resume', label: 'Resume session', description: 'Resume latest session', category: 'Session' },
  { id: ':new', label: 'New session', description: 'Start fresh session', category: 'Session' },
  { id: ':history', label: 'Show history', description: 'Turn count in current session', category: 'Session' },
  { id: ':save', label: 'Save session', description: 'Rename/save current session', category: 'Session' },
  // Model
  { id: ':model', label: 'Switch model', description: 'Interactive model selector', category: 'Model / API' },
  { id: ':provider', label: 'Provider selector', description: 'Pick provider, then model', category: 'Model / API' },
  { id: ':apikey', label: 'Set API key', description: 'Set API key for session', category: 'Model / API' },
  // Workflows
  { id: ':workflows', label: 'List workflows', description: 'All saved workflows', category: 'Workflows' },
  { id: ':workflow', label: 'Create workflow', description: 'Multi-step workflow', category: 'Workflows' },
  { id: ':machina', label: 'Machina task', description: 'Self-verification + auto-retry', category: 'Workflows' },
  { id: ':council', label: 'Council', description: 'Parallel read-only specialists', category: 'Workflows' },
  { id: ':q add', label: 'Queue task', description: 'Enqueue a task', category: 'Workflows' },
  { id: ':q list', label: 'Queue list', description: 'List queued tasks', category: 'Workflows' },
  // Memory
  { id: ':dream', label: 'Dream', description: 'Consolidate episodes', category: 'Memory' },
  { id: ':rem', label: 'Show memory', description: 'Reconciled memory', category: 'Memory' },
  { id: ':mine', label: 'Mine patterns', description: 'Mine episodes for patterns', category: 'Memory' },
  { id: ':research', label: 'Research', description: 'Multi-step research pass', category: 'Memory' },
  { id: ':btw', label: 'Side question', description: 'Quick read-only question', category: 'Memory' },
  // Voice
  { id: ':speak', label: 'Toggle voice', description: 'Read replies aloud', category: 'Voice' },
  // Safety
  { id: ':approve', label: 'Toggle auto-approve', description: 'Skip y/N prompts', category: 'Safety' },
  // System
  { id: ':help', label: 'Help', description: 'Show all commands', category: 'System' },
  { id: ':rubyon', label: 'Ruby On', description: 'Enable Ruby Alternator for this session', category: 'System' },
  { id: ':rubyoff', label: 'Ruby Off', description: 'Disable Ruby Alternator for this session', category: 'System' },
  { id: ':q', label: 'Quit', description: 'Exit Aura', category: 'System' },
  { id: ':context', label: 'Context health', description: 'Token usage dashboard', category: 'System' },
  { id: ':doctor', label: 'Doctor', description: 'Run health checks', category: 'System' },
  { id: ':compact', label: 'Force compact', description: 'Manual context compaction (alias: :compress)', category: 'System' },
  { id: ':compress', label: 'Force compress', description: 'Manual context compaction (alias: :compact)', category: 'System' },
];

/**
 * Fuzzy-match a query against a command's label + id.
 * Returns a score (lower = better match), or -1 for no match.
 */
export function fuzzyMatch(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring match — best
  const idx = t.indexOf(q);
  if (idx >= 0) return idx;

  // Fuzzy: all chars of query appear in order in text
  let qi = 0;
  let score = 0;
  let lastMatchPos = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatchPos >= 0 ? (ti - lastMatchPos) : 0;
      lastMatchPos = ti;
      qi++;
    }
  }

  return qi === q.length ? score + 100 : -1;
}

/**
 * Filter and sort commands by fuzzy match score.
 */
export function filterCommands(query: string): PaletteCommand[] {
  if (!query) return PALETTE_COMMANDS;

  const scored = PALETTE_COMMANDS.map(cmd => {
    const score = fuzzyMatch(query, cmd.label + ' ' + cmd.id);
    return { cmd, score };
  }).filter(s => s.score >= 0);

  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.cmd);
}

/**
 * Render the palette overlay. Returns styled lines to draw.
 * `selectedIdx` is the currently highlighted item.
 * `maxVisible` controls how many items fit in the overlay.
 */
export function renderPalette(
  commands: PaletteCommand[],
  query: string,
  selectedIdx: number,
  maxVisible: number,
  width: number,
): string[] {
  const lines: string[] = [];

  // Header
  lines.push(TEXT_DIM('  ┌─ command palette ' + '─'.repeat(Math.max(0, width - 21)) + '┐'));
  lines.push(TEXT_DIM('  │ ') + RUBY(query) + TEXT_DIM('_'.repeat(Math.max(0, width - query.length - 6)) + ' │'));

  const visible = commands.slice(0, maxVisible);
  const actualSelected = Math.min(selectedIdx, visible.length - 1);

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i];
    const isSelected = i === actualSelected;
    const prefix = isSelected ? RUBY('▸ ') : '  ';
    const label = isSelected ? HIGHLIGHT.bold(cmd.label) : TEXT(cmd.label);
    const desc = TEXT_DIM(`  ${cmd.description}`);
    const cat = TEXT_DIM(` [${cmd.category}]`);
    const content = `${prefix}${label}${desc}${cat}`;
    const truncContent = content.length > width - 4
      ? content.slice(0, width - 5) + '…'
      : content;
    lines.push(TEXT_DIM('  │ ') + truncContent + TEXT_DIM(' │'));
  }

  // Footer
  lines.push(TEXT_DIM('  └' + '─'.repeat(width - 4) + '┘'));
  lines.push(TEXT_DIM('  ↑↓ navigate · Enter select · Esc cancel'));

  return lines;
}

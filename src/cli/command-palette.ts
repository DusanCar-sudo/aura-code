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
 *
 * This list is not only the terminal's Ctrl+P menu: the engine serves it at
 * `/api/commands` and over `command.list`, so it is also the web client's `/`
 * menu. It had thirty-nine of the sixty-six commands `:help` advertises, which
 * meant twenty-seven were reachable only by typing them from memory on either
 * surface. Adding a command to :help means adding it here.
 */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  // Modes
  { id: ':coder', label: 'Coder mode', description: 'Full coding agent — tools and project context', category: 'Modes' },
  { id: ':gazelle', label: 'Gazelle mode', description: 'Lean conversation — no tools, no project context', category: 'Modes' },
  // Session
  { id: ':id', label: 'Show session ID', description: 'Current chat ID', category: 'Session' },
  { id: ':sessions', label: 'List sessions', description: 'All saved sessions', category: 'Session' },
  { id: ':resume', label: 'Resume session', description: 'Resume latest session', category: 'Session' },
  { id: ':new', label: 'New session', description: 'Start fresh session', category: 'Session' },
  { id: ':history', label: 'Show history', description: 'Turn count in current session', category: 'Session' },
  { id: ':save', label: 'Save session', description: 'Rename/save current session', category: 'Session' },
  { id: ':sessions all', label: 'Sessions everywhere', description: 'Saved sessions across every project', category: 'Session' },
  { id: ':clear-history', label: 'Clear history', description: 'Wipe the conversation, keep the session id', category: 'Session' },
  { id: ':delete', label: 'Delete a session', description: 'Remove a saved session by id', category: 'Session' },
  // Model
  { id: ':model', label: 'Switch model', description: 'Interactive model selector', category: 'Model / API' },
  { id: ':provider', label: 'Provider selector', description: 'Pick provider, then model', category: 'Model / API' },
  { id: ':apikey', label: 'Set API key', description: 'Set API key for session', category: 'Model / API' },
  { id: ':effort', label: 'Reasoning effort', description: 'Show or set the effort rung for this model', category: 'Model / API' },
  { id: ':skills', label: 'List skills', description: 'Skills the agent can route to', category: 'Model / API' },
  // Workflows
  { id: ':workflows', label: 'List workflows', description: 'All saved workflows', category: 'Workflows' },
  { id: ':workflow', label: 'Create workflow', description: 'Multi-step workflow', category: 'Workflows' },
  { id: ':machina', label: 'Machina task', description: 'Self-verification + auto-retry', category: 'Workflows' },
  { id: ':council', label: 'Council', description: 'Parallel read-only specialists', category: 'Workflows' },
  { id: ':q add', label: 'Queue task', description: 'Enqueue a task', category: 'Workflows' },
  { id: ':q list', label: 'Queue list', description: 'List queued tasks', category: 'Workflows' },
  { id: ':resume-workflow', label: 'Resume workflow', description: 'Continue a paused or failed workflow', category: 'Workflows' },
  { id: ':ecclesia', label: 'Ecclesia', description: '5 independent research agents, then a synthesis verdict', category: 'Workflows' },
  { id: ':nerds', label: 'Nerds', description: 'One writer at a time, readers in parallel', category: 'Workflows' },
  { id: ':marathon', label: 'Marathon', description: 'Flag a long haul (24h, lapses on its own)', category: 'Workflows' },
  { id: ':plans', label: 'Execution plans', description: 'Plans this project has run', category: 'Workflows' },
  { id: ':stop', label: 'Stop the task', description: 'Abort whatever is running (alias: :cancel)', category: 'Workflows' },
  // Design
  { id: ':designx', label: 'Design commission', description: 'Route a style, scrape references, build the artefact', category: 'Design' },
  { id: ':designx styles', label: 'Design lexicon', description: 'List the style directions :designx routes from', category: 'Design' },
  // Memory
  { id: ':dream', label: 'Dream', description: 'Consolidate episodes', category: 'Memory' },
  { id: ':rem', label: 'Show memory', description: 'Reconciled memory', category: 'Memory' },
  { id: ':mine --refine', label: 'Mine + refine patterns', description: 'Mine episodes and judge concepts with the local model', category: 'Memory' },
  { id: ':mine --corrections', label: 'Collect correction pairs', description: 'Write direct correction pairs from escalation episodes', category: 'Memory' },
  { id: ':mine --stats', label: 'Training data stats', description: 'Show training-data row counts by provenance', category: 'Memory' },
  { id: ':research', label: 'Research', description: 'Multi-step research pass', category: 'Memory' },
  { id: ':btw', label: 'Side question', description: 'Quick read-only question', category: 'Memory' },
  { id: ':lessons', label: 'Lessons learned', description: 'What Aura learned and now tells herself', category: 'Memory' },
  { id: ':lessons timeline', label: 'Learning timeline', description: 'When lessons were learned, per day', category: 'Memory' },
  { id: ':forget', label: 'Forget a lesson', description: 'Remove one learned lesson from the prompt', category: 'Memory' },
  { id: ':confess', label: 'Confess', description: 'Auto-detect and confess an anomalous episode', category: 'Memory' },
  { id: ':confessions', label: 'List confessions', description: 'Everything confessed so far', category: 'Memory' },
  { id: ':graph', label: 'Codebase graph', description: 'Knowledge-graph summary (also: extract, refresh)', category: 'Memory' },
  { id: ':viz', label: 'Memory dashboard', description: 'Generate and open it (alias: :dashboard; :viz all for every project)', category: 'Memory' },
  // Voice
  { id: ':speak', label: 'Toggle voice', description: 'Read replies aloud', category: 'Voice' },
  // Safety
  { id: ':approve', label: 'Toggle auto-approve', description: 'Skip y/N prompts', category: 'Safety' },
  { id: ':compon', label: 'Computer use on', description: 'See the screen, drive mouse and keyboard (shows the disclosure)', category: 'Safety' },
  { id: ':compoff', label: 'Computer use off', description: 'Turn it off and release the input device', category: 'Safety' },
  { id: ':comp', label: 'Computer use status', description: 'Is it on, and what is holding it there', category: 'Safety' },
  { id: ':auraweb', label: 'Open the web client', description: 'Starts the browser surface and opens it (also `webaura` from a terminal)', category: 'Session' },
  { id: ':catchthis', label: 'Catch a job', description: 'Record what you do once, then have the agent repeat it', category: 'Safety' },
  // System
  { id: ':help', label: 'Help', description: 'Show all commands', category: 'System' },
  { id: ':archon', label: 'Archimedes On', description: 'Enable Archimedes Alternator for this session', category: 'System' },
  { id: ':archoff', label: 'Archimedes Off', description: 'Disable Archimedes Alternator for this session', category: 'System' },
  { id: ':archmodel', label: 'Archimedes Model', description: 'Set Archimedes local model for this session  e.g. :archmodel qwen3-vl:4b', category: 'System' },
  { id: ':turnsoff', label: 'Turns Off', description: 'Disable per-task turn limit (unlimited)', category: 'System' },
  { id: ':turnson', label: 'Turns On', description: 'Enable per-task turn limit (default: 50)', category: 'System' },
  { id: ':turns', label: 'Turn limit', description: 'Show or set the per-task turn cap', category: 'System' },
  { id: ':small1', label: 'Start with Archimedes', description: 'Bypass the competence gate for this session', category: 'System' },
  { id: ':cost', label: 'Cost ledger', description: 'Spent vs direct-large counterfactual, per outcome', category: 'System' },
  { id: ':q', label: 'Quit', description: 'Exit Aura', category: 'System' },
  { id: ':context', label: 'Context health', description: 'Token usage dashboard', category: 'System' },
  { id: ':doctor', label: 'Doctor', description: 'Run health checks', category: 'System' },
  { id: ':compact', label: 'Force compact', description: 'Manual context compaction (alias: :compress)', category: 'System' },
  { id: ':compress', label: 'Force compress', description: 'Manual context compaction (alias: :compact)', category: 'System' },
  { id: ':quit', label: 'Quit', description: 'Exit Aura (aliases: :q, /exit)', category: 'System' },
  // Stats — the slash half of the set, which had no palette entries at all
  { id: '/stats', label: 'Session usage', description: 'Tokens and cost this session (alias: /usage)', category: 'Stats' },
  { id: '/cost', label: 'Cache report', description: 'Cache hit rate and cost per call', category: 'Stats' },
  { id: '/context', label: 'Context health', description: 'Window, compaction ladder, cost', category: 'Stats' },
  { id: '/clear', label: 'Reset usage stats', description: 'Zero the counters — history untouched (alias: /reset)', category: 'Stats' },
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

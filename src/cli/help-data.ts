/**
 * Single source of truth for the ":help" text. The REPL's `:help` command
 * prints HELP_TEXT verbatim; the TUI's right-side panel derives its "quick
 * commands" list from `findCommand()` below instead of hardcoding its own
 * copy of descriptions — so if a command is renamed or dropped here, the
 * panel picks that up (or silently omits it) rather than going stale.
 */

export const HELP_TEXT = [
  '',
  '  ── Session ──────────────────────────────────────',
  '  :id                     Show current chat ID',
  '  :sessions               List all saved sessions',
  '  :resume                 Resume the latest session',
  '  :resume <id>            Resume a specific session by ID',
  '  :new                    Start a new session (fresh history)',
  '  :history                Show turn count in current session',
  '  :clear-history          Wipe conversation history (keep session ID)',
  '  :save [title]           Rename / save current session',
  '  :delete <id>            Delete a saved session',
  '',
  '  ── Model / API ──────────────────────────────────',
  '  :model                  Interactive model selector',
  '  :model <id>             Switch to a specific model',
  '  :models                 List all available models',
  '  :provider               Provider setup wizard (pick provider, model, key)',
  '  :apikey <key>           Set API key for current session',
  '',
  '  ── Workflows ─────────────────────────────────────',
  '  :workflows              List all saved workflows',
  '  :workflow               Create & run a multi-step workflow',
  '    <name> "step1" "step2" ...',
  '  :resume-workflow <id>   Resume a paused/failed workflow',
  '  :q add <prompt>         Enqueue a task in the queue',
  '  :q list                 List queued tasks',
  '  :q run <n>              Execute queued task #n',
  '  :q drop <n>             Remove queued task #n',
  '  :q clear                Wipe the queue',
  '  :machina <task>         Run task with self-verification + auto-retry',
  '  :council <task>         2-3 parallel read-only specialists, then synthesis',
  '',
  '  ── Memory / Side ─────────────────────────────────',
  '  :dream                  Consolidate recent episodes into a dream entry',
  '  :dream full             Consolidate ALL episodes, ignoring last-dream cutoff',
  '  :rem                    Show reconciled memory (or latest dream)',
  '  :research <topic>       Multi-step research pass, saved to research/*.md',
  '  :confess                Auto-detect & confess an anomalous episode',
  '  :confessions            List all confessions',
  '  :btw <question>         Quick side question (read-only, no history pollution)',
  '',
  '  ── Voice ─────────────────────────────────────────',
  '  :speak                  Toggle reading replies aloud (or launch with --speak)',
  '',
  '  ── Safety ────────────────────────────────────────',
  '  :approve                Toggle auto-approve (skip per-command y/N prompts)',
  '  :approve all            Approve everything this session',
  '  :approve off            Re-enable confirmation for destructive commands',
  '',
  '  ── Context / Stats ──────────────────────────────',
  '  :context                Show loaded project context',
  '  :graph                  Show codebase knowledge graph summary',
  '  :graph refresh          Reload graph from graphify-out/graph.json',
  '  :plans                  List saved execution plans',
  '  :viz, :dashboard        Generate and open the memory dashboard',
  '  :doctor                 Scan Aura itself for issues (build, config, deps, env)',
  '  :doctor --fix           Scan and attempt auto-repairs',
  '  /stats, /usage          Show token + cost usage this session',
  '  /context                Context health dashboard (window, compaction, cost)',
  '  /clear, /reset          Reset cumulative usage stats',
  '',
  '  ── General ──────────────────────────────────────',
  '  :quit, :q, /exit        Exit',
  '',
];

export interface HelpCommand {
  cmd: string;
  desc: string;
}

/** All commands parsed out of HELP_TEXT: "  :cmd <arg>   description" lines. */
export const HELP_COMMANDS: HelpCommand[] = HELP_TEXT
  .map(line => line.match(/^ {2}(:\S[^ ]*(?: <[^>]+>| \[[^\]]+\]|,\s*\S+)*)\s{2,}(.+)$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map(m => ({ cmd: m[1].trim(), desc: m[2].trim() }));

/**
 * Look up a command's description by exact or prefix match on its first
 * token (":dream" matches both ":dream" and ":dream full"). Returns
 * undefined if the command was renamed/removed since the panel's static
 * quick-list was written — callers should skip it rather than fabricate
 * a description.
 */
export function findCommand(name: string): HelpCommand | undefined {
  return HELP_COMMANDS.find(c => c.cmd === name || c.cmd.startsWith(name + ' '))
    ?? HELP_COMMANDS.find(c => c.cmd.split(/[ ,]/)[0] === name);
}

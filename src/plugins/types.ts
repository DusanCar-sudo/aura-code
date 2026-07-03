/**
 * Claude Code plugin compatibility — shared types.
 *
 * Aura loads plugins in the Claude Code plugin format so the existing
 * ecosystem (marketplaces with hundreds of published plugins) works here:
 *
 *   <plugin>/
 *     .claude-plugin/plugin.json     — manifest {name, version, description}
 *     commands/<name>.md             — slash commands (frontmatter + prompt)
 *     agents/<name>.md               — agent definitions (frontmatter + system prompt)
 *     skills/<name>/SKILL.md         — skills (frontmatter + prompt body)
 *     hooks/hooks.json               — PreToolUse/PostToolUse/… hook commands
 *     .mcp.json                      — MCP servers (NOT supported — warned at load)
 *
 * Marketplaces are git repos with .claude-plugin/marketplace.json listing
 * plugins by name + source.
 */

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
}

/** A slash command from commands/<name>.md — invoked as /name or /plugin:name. */
export interface PluginCommand {
  /** Invocation name (file basename; subdirs join with ":", e.g. "git:commit"). */
  name: string;
  pluginName: string;
  description?: string;
  /** Hint shown in listings, e.g. "[pr-number]". */
  argumentHint?: string;
  /** Prompt template body ($ARGUMENTS / $1..$9 / !`cmd` are expanded). */
  body: string;
  filePath: string;
}

/** An agent from agents/<name>.md — its body becomes the task's system preamble. */
export interface PluginAgent {
  name: string;
  pluginName: string;
  description?: string;
  systemPrompt: string;
  filePath: string;
}

/** A skill from skills/<name>/SKILL.md — exposed like a command in aura. */
export interface PluginSkill {
  name: string;
  pluginName: string;
  description?: string;
  body: string;
  dir: string;
}

export type HookEvent = 'PreToolUse' | 'PostToolUse';

/** One flattened hook: event + optional tool matcher + shell command. */
export interface HookEntry {
  event: HookEvent;
  /** Regex over the tool name (Claude Code names like "Bash" and aura names both match). */
  matcher?: string;
  command: string;
  /** Seconds before the hook process is killed (default 60). */
  timeout?: number;
  pluginName: string;
  /** Absolute plugin dir — substituted for ${CLAUDE_PLUGIN_ROOT} in command. */
  pluginRoot: string;
}

export interface LoadedPlugin {
  name: string;
  /** Absolute path of the installed plugin directory. */
  path: string;
  manifest: PluginManifest;
  commands: PluginCommand[];
  agents: PluginAgent[];
  skills: PluginSkill[];
  hooks: HookEntry[];
  /** Count of MCP servers declared in .mcp.json (unsupported, surfaced as a warning). */
  mcpServerCount: number;
}

/** Entry in a marketplace.json plugin list. */
export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  /** Relative path within the marketplace repo, "owner/repo", a git URL, or {source, repo|url|path}. */
  source: unknown;
}

export interface Marketplace {
  name: string;
  /** Absolute path of the cloned marketplace repo. */
  path: string;
  description?: string;
  plugins: MarketplacePluginEntry[];
}

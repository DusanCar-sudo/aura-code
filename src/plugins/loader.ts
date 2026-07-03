/**
 * Plugin loader — reads installed plugins (Claude Code format) from
 * ~/.aura/plugins/<name> and parses their commands, agents, skills, and hooks.
 *
 * Loading is tolerant: a malformed file skips that file, a malformed plugin
 * skips that plugin — plugins must never brick the CLI.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter.js';
import type {
  HookEntry, HookEvent, LoadedPlugin, PluginAgent, PluginCommand,
  PluginManifest, PluginSkill,
} from './types.js';

export function pluginsDir(): string {
  return process.env.AURA_PLUGIN_DIR
    ?? path.join(process.env.HOME ?? os.homedir(), '.aura', 'plugins');
}

export function marketplacesDir(): string {
  return process.env.AURA_MARKETPLACE_DIR
    ?? path.join(process.env.HOME ?? os.homedir(), '.aura', 'marketplaces');
}

/** Load every plugin installed in the plugins dir. Never throws. */
export function loadAllPlugins(): LoadedPlugin[] {
  const dir = pluginsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(e => {
      try { return fs.statSync(path.join(dir, e)).isDirectory(); }
      catch { return false; }
    });
  } catch {
    return [];
  }

  const plugins: LoadedPlugin[] = [];
  for (const entry of entries.sort()) {
    const plugin = loadPlugin(path.join(dir, entry));
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

/** Load a single plugin directory. Returns null when it isn't a plugin. */
export function loadPlugin(dir: string): LoadedPlugin | null {
  let manifest: PluginManifest | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (typeof raw === 'object' && raw !== null && typeof raw.name === 'string') {
      manifest = {
        name: raw.name,
        version: typeof raw.version === 'string' ? raw.version : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        author: typeof raw.author === 'string' ? raw.author
          : typeof raw.author?.name === 'string' ? raw.author.name : undefined,
      };
    }
  } catch { /* manifest optional — fall back to dir name */ }

  const name = manifest?.name ?? path.basename(dir);
  const commands = loadCommands(dir, name);
  const agents = loadAgents(dir, name);
  const skills = loadSkills(dir, name);
  const hooks = loadHooks(dir, name);
  const mcpServerCount = countMcpServers(dir);

  // A directory with no manifest and no plugin content isn't a plugin.
  if (!manifest && commands.length === 0 && agents.length === 0 && skills.length === 0 && hooks.length === 0) {
    return null;
  }

  return {
    name, path: dir,
    manifest: manifest ?? { name },
    commands, agents, skills, hooks, mcpServerCount,
  };
}

function mdFilesRecursive(dir: string, base = dir): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(mdFilesRecursive(full, base));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function loadCommands(pluginDir: string, pluginName: string): PluginCommand[] {
  const dir = path.join(pluginDir, 'commands');
  const out: PluginCommand[] = [];
  for (const file of mdFilesRecursive(dir).sort()) {
    try {
      const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      // commands/foo.md → "foo"; commands/git/commit.md → "git:commit"
      const rel = path.relative(dir, file).replace(/\.md$/, '');
      const name = rel.split(path.sep).join(':');
      out.push({
        name, pluginName,
        description: str(data.description),
        argumentHint: str(data['argument-hint']),
        body: body.trim(),
        filePath: file,
      });
    } catch { /* skip malformed command file */ }
  }
  return out;
}

function loadAgents(pluginDir: string, pluginName: string): PluginAgent[] {
  const dir = path.join(pluginDir, 'agents');
  const out: PluginAgent[] = [];
  for (const file of mdFilesRecursive(dir).sort()) {
    try {
      const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({
        name: str(data.name) ?? path.basename(file, '.md'),
        pluginName,
        description: str(data.description),
        systemPrompt: body.trim(),
        filePath: file,
      });
    } catch { /* skip malformed agent file */ }
  }
  return out;
}

function loadSkills(pluginDir: string, pluginName: string): PluginSkill[] {
  const dir = path.join(pluginDir, 'skills');
  const out: PluginSkill[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  for (const entry of entries.sort()) {
    const skillFile = path.join(dir, entry, 'SKILL.md');
    try {
      const { data, body } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      out.push({
        name: str(data.name) ?? entry,
        pluginName,
        description: str(data.description),
        body: body.trim(),
        dir: path.join(dir, entry),
      });
    } catch { /* no SKILL.md or malformed — skip */ }
  }
  return out;
}

/**
 * hooks/hooks.json, Claude Code schema:
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash",
 *       "hooks": [ { "type": "command", "command": "…", "timeout": 60 } ] } ] } }
 * Flattened to HookEntry[]. Only PreToolUse/PostToolUse are supported — other
 * events are silently ignored (they have no aura equivalent yet).
 */
function loadHooks(pluginDir: string, pluginName: string): HookEntry[] {
  const out: HookEntry[] = [];
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8')); }
  catch { return []; }

  const events = (raw as Record<string, unknown>)?.hooks;
  if (typeof events !== 'object' || events === null) return [];

  for (const event of ['PreToolUse', 'PostToolUse'] as HookEvent[]) {
    const groups = (events as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of hooks) {
        if (typeof h?.command !== 'string') continue;
        out.push({
          event, matcher,
          command: h.command,
          timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
          pluginName,
          pluginRoot: pluginDir,
        });
      }
    }
  }
  return out;
}

function countMcpServers(pluginDir: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8'));
    const servers = raw?.mcpServers;
    return typeof servers === 'object' && servers !== null ? Object.keys(servers).length : 0;
  } catch {
    return 0;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

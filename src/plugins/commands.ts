/**
 * Plugin command expansion — turns "/name args" into the task prompt that
 * runs through the normal agent loop.
 *
 * Substitutions (Claude Code compatible):
 *   $ARGUMENTS      — the full argument string
 *   $1 … $9         — whitespace-split positional arguments
 *   !`cmd`          — replaced with the command's stdout. Gated by the same
 *                     safety posture as run_shell: auto mode runs it,
 *                     read-only skips it, normal mode asks via confirmFn.
 *   @path           — left as-is: the agent has read_file and the prompt
 *                     tells it to read referenced files itself.
 *
 * Frontmatter `model:` and `allowed-tools:` are parsed but ignored — aura is
 * provider-agnostic and its permission system governs tools (documented in
 * docs/PLUGINS.md).
 */
import { execFile } from 'child_process';
import type { LoadedPlugin, PluginAgent, PluginCommand, PluginSkill } from './types.js';

export type CommandMatch =
  | { kind: 'command'; command: PluginCommand }
  | { kind: 'skill'; skill: PluginSkill }
  | { kind: 'agent'; agent: PluginAgent }
  | { kind: 'ambiguous'; candidates: string[] }
  | null;

/**
 * Resolve "/name" against loaded plugins. Accepts bare names ("review"),
 * plugin-qualified names ("pr-tools:review"), and falls back through
 * commands → skills → agents. Ambiguous bare names across plugins return
 * the candidate list instead of guessing.
 */
export function findInvocable(plugins: LoadedPlugin[], rawName: string): CommandMatch {
  const name = rawName.replace(/^\//, '');

  // Qualified: plugin:name (also covers subdir commands like git:commit —
  // try both interpretations).
  if (name.includes(':')) {
    const [pluginName, ...rest] = name.split(':');
    const inner = rest.join(':');
    const plugin = plugins.find(p => p.name === pluginName);
    if (plugin) {
      const cmd = plugin.commands.find(c => c.name === inner);
      if (cmd) return { kind: 'command', command: cmd };
      const skill = plugin.skills.find(s => s.name === inner);
      if (skill) return { kind: 'skill', skill };
      const agent = plugin.agents.find(a => a.name === inner);
      if (agent) return { kind: 'agent', agent };
    }
    // Fall through: the colon may be a subdir namespace, not a plugin name.
  }

  const commands = plugins.flatMap(p => p.commands).filter(c => c.name === name);
  if (commands.length === 1) return { kind: 'command', command: commands[0] };
  if (commands.length > 1) {
    return { kind: 'ambiguous', candidates: commands.map(c => `${c.pluginName}:${c.name}`) };
  }

  const skills = plugins.flatMap(p => p.skills).filter(s => s.name === name);
  if (skills.length === 1) return { kind: 'skill', skill: skills[0] };
  if (skills.length > 1) {
    return { kind: 'ambiguous', candidates: skills.map(s => `${s.pluginName}:${s.name}`) };
  }

  const agents = plugins.flatMap(p => p.agents).filter(a => a.name === name);
  if (agents.length === 1) return { kind: 'agent', agent: agents[0] };
  if (agents.length > 1) {
    return { kind: 'ambiguous', candidates: agents.map(a => `${a.pluginName}:${a.name}`) };
  }

  return null;
}

export interface ExpandOptions {
  cwd: string;
  /** 'auto' runs !`cmd` preprocessing, 'read-only' skips it, 'normal' confirms. */
  mode: 'read-only' | 'normal' | 'auto';
  /** Asked once per !`cmd` in normal mode. Defaults to deny when omitted. */
  confirmFn?: (message: string) => Promise<boolean>;
  /** Timeout per !`cmd` execution (ms). */
  shellTimeoutMs?: number;
}

/** Expand a command body with the given argument string into the final task prompt. */
export async function expandCommand(
  command: Pick<PluginCommand, 'body'>,
  argsStr: string,
  opts: ExpandOptions,
): Promise<string> {
  let body = command.body;
  const args = splitArgs(argsStr);

  const usesPlaceholders = /\$ARGUMENTS|\$[1-9]/.test(body);
  body = body.replace(/\$ARGUMENTS/g, argsStr);
  body = body.replace(/\$([1-9])/g, (_, n) => args[Number(n) - 1] ?? '');

  // !`cmd` shell preprocessing
  const shellRefs = [...body.matchAll(/!`([^`]+)`/g)];
  for (const ref of shellRefs) {
    const cmd = ref[1];
    let replacement: string;
    if (opts.mode === 'read-only') {
      replacement = `[shell preprocessing skipped in read-only mode: ${cmd}]`;
    } else if (opts.mode === 'normal') {
      const approved = opts.confirmFn ? await opts.confirmFn(`Plugin command wants to run: $ ${cmd}`) : false;
      replacement = approved
        ? await runPreprocess(cmd, opts)
        : `[shell preprocessing declined: ${cmd}]`;
    } else {
      replacement = await runPreprocess(cmd, opts);
    }
    body = body.replace(ref[0], replacement);
  }

  // No placeholders but args given → append them (Claude Code behavior).
  if (!usesPlaceholders && argsStr.trim()) {
    body = `${body}\n\nARGUMENTS: ${argsStr.trim()}`;
  }

  return body;
}

/** Build the task for a plugin agent: its system prompt preambles the task. */
export function expandAgentTask(agent: PluginAgent, task: string): string {
  return `${agent.systemPrompt}\n\n---\n\n${task.trim() || 'Proceed with your role as described above.'}`;
}

/** Build the task for a skill: SKILL.md body + the user's request. */
export function expandSkillTask(skill: PluginSkill, task: string): string {
  const header = `The following skill instructions apply to this task (from plugin "${skill.pluginName}", skill files live in ${skill.dir}):`;
  return `${header}\n\n${skill.body}\n\n---\n\n${task.trim() || 'Apply this skill to the current project.'}`;
}

function runPreprocess(cmd: string, opts: ExpandOptions): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'bash', ['-c', cmd],
      { cwd: opts.cwd, timeout: opts.shellTimeoutMs ?? 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve(`[shell preprocessing failed: ${(stderr || err.message).trim().slice(0, 200)}]`);
        else resolve(stdout.trim().slice(0, 8000));
      },
    );
  });
}

/** Whitespace split honoring double/single quotes: a "b c" → ["a", "b c"]. */
export function splitArgs(argsStr: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsStr)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

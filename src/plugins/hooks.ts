/**
 * Plugin hook runner — executes Claude Code-style hooks around tool calls.
 *
 * Compatibility contract (matches Claude Code so published plugins work
 * unmodified):
 *   - The hook command receives a JSON payload on stdin with the Claude Code
 *     tool name and input-key spelling (Bash/Write/Edit…, file_path/…).
 *   - Exit code 2 blocks the tool call (PreToolUse); stderr becomes the
 *     reason fed back to the model. Any other non-zero exit is a warning.
 *   - stdout JSON {"decision": "block", "reason": "…"} also blocks.
 *   - ${CLAUDE_PLUGIN_ROOT} in the command is replaced with the plugin dir;
 *     $CLAUDE_PROJECT_DIR is provided as an env var.
 *
 * Security note: hooks are user-installed code and run unsandboxed with the
 * user's privileges by design — installing a plugin is trusting its author,
 * exactly like installing an npm package. Documented in docs/SECURITY.md.
 */
import { spawn } from 'child_process';
import type { HookEntry, HookEvent } from './types.js';

export interface HookOutcome {
  /** True when a PreToolUse hook blocked the call. */
  block: boolean;
  /** Reasons from blocking hooks / warnings from failing ones. */
  messages: string[];
}

/** aura tool name → Claude Code tool name (what hook matchers/scripts expect). */
const CLAUDE_TOOL_ALIAS: Record<string, string> = {
  run_shell: 'Bash',
  write_file: 'Write',
  edit_file: 'Edit',
  read_file: 'Read',
  list_dir: 'Glob',
  search_code: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  run_tests: 'Bash',
  spawn_task: 'Task',
};

/** aura input shape → Claude Code input-key spelling, per tool. */
function toClaudeInput(auraName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (auraName) {
    case 'write_file': return { file_path: input.path, content: input.content };
    case 'edit_file':  return { file_path: input.path, old_string: input.find, new_string: input.replace };
    case 'read_file':  return { file_path: input.path };
    case 'run_shell':  return { command: input.command, timeout: input.timeout };
    default:           return input;
  }
}

const DEFAULT_TIMEOUT_S = 60;

/**
 * Run every hook registered for `event` whose matcher covers this tool.
 * Hook failures (bad command, timeout, non-2 exit) never block — they warn.
 */
export async function runHooks(
  event: HookEvent,
  toolName: string,
  toolInput: Record<string, unknown>,
  entries: HookEntry[],
  projectRoot: string,
  toolResponse?: string,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { block: false, messages: [] };
  const claudeName = CLAUDE_TOOL_ALIAS[toolName] ?? toolName;

  for (const entry of entries) {
    if (entry.event !== event) continue;
    if (!matcherCovers(entry.matcher, claudeName, toolName)) continue;

    const payload = JSON.stringify({
      hook_event_name: event,
      tool_name: claudeName,
      tool_input: toClaudeInput(toolName, toolInput),
      ...(toolResponse !== undefined ? { tool_response: toolResponse.slice(0, 8000) } : {}),
      cwd: projectRoot,
      // aura-specific extras, namespaced so CC-written hooks are unaffected
      aura: { tool_name: toolName, tool_input: toolInput },
    });

    const command = entry.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, entry.pluginRoot);
    const result = await execHook(command, payload, projectRoot, entry);

    if (result.blocked) {
      outcome.block = true;
      if (result.reason) outcome.messages.push(`[${entry.pluginName}] ${result.reason}`);
    } else if (result.warning) {
      outcome.messages.push(`[${entry.pluginName}] ${result.warning}`);
    }
  }

  return outcome;
}

function matcherCovers(matcher: string | undefined, claudeName: string, auraName: string): boolean {
  if (!matcher || matcher === '*' || matcher === '') return true;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return re.test(claudeName) || re.test(auraName);
  } catch {
    return matcher === claudeName || matcher === auraName;
  }
}

function execHook(
  command: string,
  payload: string,
  cwd: string,
  entry: HookEntry,
): Promise<{ blocked: boolean; reason?: string; warning?: string }> {
  return new Promise(resolve => {
    const timeoutMs = (entry.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
    let child;
    try {
      child = spawn(command, {
        shell: true, cwd,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: cwd,
          AURA_PROJECT_DIR: cwd,
          CLAUDE_PLUGIN_ROOT: entry.pluginRoot,
        },
      });
    } catch (e) {
      resolve({ blocked: false, warning: `hook failed to start: ${String(e)}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (v: { blocked: boolean; reason?: string; warning?: string }) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ blocked: false, warning: `hook timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    child.on('error', e => settle({ blocked: false, warning: `hook error: ${String(e)}` }));
    child.on('close', code => {
      // stdout JSON verdict wins regardless of exit code
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.decision === 'block') {
          settle({ blocked: true, reason: String(parsed.reason ?? stderr.trim() ?? 'blocked') });
          return;
        }
      } catch { /* stdout wasn't JSON — fall through to exit-code semantics */ }

      if (code === 2) settle({ blocked: true, reason: stderr.trim() || 'blocked by hook' });
      else if (code !== 0) settle({ blocked: false, warning: `hook exited ${code}: ${stderr.trim().slice(0, 200)}` });
      else settle({ blocked: false });
    });

    child.stdin?.on('error', () => { /* hook may not read stdin — ignore EPIPE */ });
    child.stdin?.end(payload);
  });
}

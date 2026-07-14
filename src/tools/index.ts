import type { ToolDefinition, HistoryMessage } from '../providers/types.js';
import { readFile } from './read-file.js';
import { listDir } from './list-dir.js';
import { editFile } from './edit-file.js';
import { writeFile } from './write-file.js';
import { searchCode } from './search-code.js';
import { runShell } from './run-shell.js';
import { runTests } from './run-tests.js';
import { gitStatus, gitDiff } from './git.js';
import { SPAWN_TASK_DEFINITION, executeSpawnTask } from '../agent/spawner.js';
import { WEB_FETCH_DEFINITION, webFetch } from './web-fetch.js';
import { BROWSER_DEFINITION, browserTool } from './browser.js';
import { WEB_SEARCH_DEFINITION, webSearch } from './web-search.js';
import { HTTP_REQUEST_DEFINITION, httpRequest } from './http-request.js';
import { MEMORY_DEFINITION, memoryTool } from './memory.js';
import { CLIPBOARD_DEFINITION, clipboardTool } from './clipboard.js';
import { NOTIFY_DEFINITION, notifyTool } from './notify.js';
import { IMAGE_READ_DEFINITION, imageRead } from './image-read.js';
import { EMAIL_DEFINITION, emailTool } from './email.js';
import { CALENDAR_DEFINITION, calendarTool } from './calendar.js';
import { TELEGRAM_DEFINITION, telegramTool } from './telegram.js';
import { WHATSAPP_DEFINITION, whatsAppTool } from './whatsapp.js';
import { CRON_DEFINITION, cronTool } from './cron.js';
import { MCP_DEFINITION, mcpTool } from './mcp.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool schemas (what the model sees)
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read file contents with line numbers. Use start_line/end_line for ranges.',
    parameters: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'Path to the file (relative to project root)' },
        start_line: { type: 'number', description: 'First line to read (1-indexed, inclusive)' },
        end_line:   { type: 'number', description: 'Last line to read (inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files/directories. Respects .gitignore. recursive=true for full tree.',
    parameters: {
      type: 'object',
      properties: {
        path:      { type: 'string',  description: 'Directory path (default: project root)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        depth:     { type: 'number',  description: 'Max depth for recursive listing (default: 3)' },
      },
      required: [],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text block in file. Returns error context if block not found.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to the file to edit' },
        find:    { type: 'string', description: 'Exact text block to find and replace. Must be unique in file.' },
        replace: { type: 'string', description: 'New text to replace the found block with' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file (creates if new). For existing files, prefer edit_file unless replacing entire file.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Full content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_code',
    description: 'Search codebase with ripgrep/grep. Returns matches with file/line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern:    { type: 'string', description: 'Search pattern (regex or literal string)' },
        path:       { type: 'string', description: 'Directory to search in (default: project root)' },
        file_glob:  { type: 'string', description: 'File pattern filter, e.g. "*.ts" or "*.py"' },
        literal:    { type: 'boolean', description: 'Treat pattern as literal string, not regex (default: false)' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default: 50)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_shell',
    description: 'Run shell command in project directory. Use for build/pkgmgr/fmt/lint. Avoid destructive commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd:     { type: 'string', description: 'Working directory (default: project root)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_tests',
    description: 'Run test suite or specific file. Auto-detects framework (Jest/Vitest/pytest/go test).',
    parameters: {
      type: 'object',
      properties: {
        file_or_pattern: { type: 'string', description: 'Specific test file or pattern to run (runs all tests if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'git_status',
    description: 'Show git status: modified files, staged changes, recent commits.',
    parameters: {
      type: 'object', properties: {}, required: [],
    },
  },
  {
    name: 'git_diff',
    description: 'Show diff for specific file or all changes.',
    parameters: {
      type: 'object',
      properties: {
        path:   { type: 'string',  description: 'Specific file to diff (all files if omitted)' },
        staged: { type: 'boolean', description: 'Show staged (indexed) changes (default: false)' },
      },
      required: [],
    },
  },
  SPAWN_TASK_DEFINITION,
  WEB_FETCH_DEFINITION,
  BROWSER_DEFINITION,
  WEB_SEARCH_DEFINITION,
  HTTP_REQUEST_DEFINITION,
  MEMORY_DEFINITION,
  CLIPBOARD_DEFINITION,
  NOTIFY_DEFINITION,
  IMAGE_READ_DEFINITION,
  EMAIL_DEFINITION,
  CALENDAR_DEFINITION,
  TELEGRAM_DEFINITION,
  WHATSAPP_DEFINITION,
  CRON_DEFINITION,
  MCP_DEFINITION,
];

// ─────────────────────────────────────────────────────────────────────────────
// Relevance gate — conditional tools are only sent to the model when the task
// or conversation mentions their domain. Same mechanic as the plugin-skill
// keyword gate in system-prompt.ts. Triggers are deliberately generous: a
// false positive costs a few hundred tokens, a false negative breaks the task.
// ─────────────────────────────────────────────────────────────────────────────

const CONDITIONAL_TOOL_TRIGGERS: Record<string, RegExp> = {
  telegram:     /telegram|\btg\b|\bbot\b|send me|message me|text me|ping me|notify me/,
  browser:      /browser|chrome|website|webpage|web page|screenshot|click|navigate|scrape|open .{0,20}page|\burl\b/,
  http_request: /\bhttp\b|\bapi\b|endpoint|curl|webhook|\brest\b|\brequest\b|post to/,
  calendar:     /calendar|\bevents?\b|meeting|appointment|schedule|remind/,
  cron:         /\bcron\b|schedule|recurring|daily|weekly|hourly|\bevery\b|periodically/,
  whatsapp:     /whatsapp|\bwa\b|send me|message me/,
  email:        /e-?mail|\bmail\b|inbox|gmail|smtp/,
  notify:       /notify|notification|alert|when done|ping|desktop/,
  image_read:   /image|screenshot|png|jpe?g|photo|picture|webcam/,
  clipboard:    /clipboard|copy to|paste/,
  spawn_task:   /\b(spawn|sub.?agent|parallel|delegate|orchestrat|multi.?agent)\b/i,
  web_fetch:    /\b(http|https|url|fetch|curl|download|website|webpage|endpoint)\b/i,
  web_search:   /\b(search|look up|find online|google|latest|current|news|recent)\b/i,
  memory:       /\b(remember|recall|memory|forget|note|store|what did|last time)\b/i,
  mcp:          /\b(mcp|tool server|external tool|connect to)\b/i,
};

/** Text the gate scans: task + user/assistant messages (tool results excluded — huge and noisy). */
function gateText(task: string, history: HistoryMessage[]): string {
  const parts = [task];
  for (const msg of history) {
    if (msg.role === 'user') parts.push(msg.content);
    else if (msg.role === 'assistant' && msg.content) parts.push(msg.content);
  }
  return parts.join('\n').toLowerCase();
}

/**
 * Select the tool definitions to send this turn: all CORE tools plus any
 * conditional tool whose trigger matches the task or conversation so far.
 *
 * `included` is a sticky per-session set: once a conditional tool is
 * triggered it stays for the rest of the session, even if compaction later
 * rewrites the keyword out of history. Additive-only also means the
 * Anthropic prompt-cache prefix (tools block) is busted at most once per
 * newly triggered tool instead of thrashing.
 *
 * Call once per turn — mid-session pivots ("actually send this via
 * telegram") land in history as user messages, so the tool is present
 * before the model responds to them.
 */
export function selectTools(
  task: string,
  history: HistoryMessage[],
  included: Set<string> = new Set(),
): ToolDefinition[] {
  const text = gateText(task, history);
  for (const [name, trigger] of Object.entries(CONDITIONAL_TOOL_TRIGGERS)) {
    if (!included.has(name) && trigger.test(text)) included.add(name);
  }
  const selected = TOOL_DEFINITIONS.filter(
    t => !(t.name in CONDITIONAL_TOOL_TRIGGERS) || included.has(t.name),
  );
  if (process.env.AURA_DEBUG_TOOLS) {
    const chars = JSON.stringify(selected).length;
    console.error(`[tools] sent=${selected.length}/${TOOL_DEFINITIONS.length} chars=${chars}`);
  }
  return selected;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool executor — dispatches to the right implementation
// ─────────────────────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':    return readFile({ path: input.path as string, start_line: input.start_line as number | undefined, end_line: input.end_line as number | undefined }, cwd);
      case 'list_dir':     return listDir({ path: (input.path as string) ?? '.', recursive: (input.recursive as boolean) ?? false, depth: (input.depth as number) ?? 3 }, cwd);
      case 'edit_file':    return editFile({ path: input.path as string, find: input.find as string, replace: input.replace as string }, cwd);
      case 'write_file':   return writeFile({ path: input.path as string, content: input.content as string }, cwd);
      case 'search_code':  return searchCode({ pattern: input.pattern as string, path: input.path as string | undefined, file_glob: input.file_glob as string | undefined, literal: (input.literal as boolean) ?? false, case_sensitive: (input.case_sensitive as boolean) ?? false, max_results: (input.max_results as number) ?? 50 }, cwd);
      case 'run_shell':    return runShell({ command: input.command as string, cwd: input.cwd as string | undefined, timeout: input.timeout as number | undefined }, cwd);
      case 'run_tests':    return runTests({ file_or_pattern: input.file_or_pattern as string | undefined }, cwd);
      case 'git_status':   return gitStatus(cwd);
      case 'git_diff':     return gitDiff({ path: input.path as string | undefined, staged: (input.staged as boolean) ?? false }, cwd);
      case 'spawn_task':   return executeSpawnTask(input);
      case 'web_fetch':    return webFetch({ url: input.url as string, method: input.method as any, headers: input.headers as Record<string, string> | undefined, body: input.body as string | undefined, max_chars: input.max_chars as number | undefined, timeout_ms: input.timeout_ms as number | undefined });
      case 'browser':      return browserTool(input as any);
      case 'web_search':   return webSearch({ query: input.query as string, max_results: input.max_results as number | undefined, region: input.region as string | undefined });
      case 'http_request': return httpRequest({ url: input.url as string, method: input.method as any, headers: input.headers as Record<string, string> | undefined, body: input.body as string | undefined, json: input.json, max_chars: input.max_chars as number | undefined, timeout_ms: input.timeout_ms as number | undefined });
      case 'memory':       return memoryTool(input as any);
      case 'clipboard':    return clipboardTool(input as any);
      case 'notify':       return notifyTool(input as any);
      case 'image_read':   return imageRead(input as any);
      case 'email':        return emailTool(input as any);
      case 'calendar':     return calendarTool(input as any);
      case 'telegram':     return telegramTool(input as any);
      case 'whatsapp':     return whatsAppTool(input as any);
      case 'cron':         return cronTool(input as any);
      case 'mcp':          return mcpTool(input as any);
      default:             return `Error: Unknown tool '${name}'`;
    }
  } catch (e) {
    return `Tool error (${name}): ${String(e)}`;
  }
}

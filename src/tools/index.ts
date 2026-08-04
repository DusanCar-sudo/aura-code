import type { ToolDefinition } from '../providers/types.js';
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
        path:       { type: 'string', description: 'File path (relative to project root)' },
        start_line: { type: 'number', description: 'First line (1-indexed, inclusive)' },
        end_line:   { type: 'number', description: 'Last line (inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List directory contents. Respects .gitignore.',
    parameters: {
      type: 'object',
      properties: {
        path:      { type: 'string',  description: 'Directory path (default: root)' },
        recursive: { type: 'boolean', description: 'Recursive listing (default: false)' },
        depth:     { type: 'number',  description: 'Max depth (default: 3)' },
      },
      required: [],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text block in file. More reliable than full rewrite.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        find:    { type: 'string', description: 'Exact block to find (must be unique)' },
        replace: { type: 'string', description: 'New replacement text' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'write_file',
    description: 'Write file (creates or replaces). Use edit_file for partial changes.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_code',
    description: 'Search codebase with regex/literal. Returns matches with file:line.',
    parameters: {
      type: 'object',
      properties: {
        pattern:         { type: 'string', description: 'Search pattern' },
        path:            { type: 'string', description: 'Directory (default: root)' },
        file_glob:       { type: 'string', description: 'File filter (*.ts)' },
        literal:         { type: 'boolean', description: 'Literal match (default: false)' },
        case_sensitive:  { type: 'boolean', description: 'Case sensitive (default: false)' },
        max_results:     { type: 'number', description: 'Max results (default: 50)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_shell',
    description: 'Run shell command. Use for builds, installs, linters.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        cwd:     { type: 'string', description: 'Working directory (default: root)' },
        timeout: { type: 'number', description: 'Timeout ms (default: 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_tests',
    description: 'Run tests. Auto-detects framework (Jest, pytest, etc.).',
    parameters: {
      type: 'object',
      properties: {
        file_or_pattern: { type: 'string', description: 'Test file/pattern (all if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'git_status',
    description: 'Show git status: modified, staged, commits.',
    parameters: {
      type: 'object', properties: {}, required: [],
    },
  },
  {
    name: 'git_diff',
    description: 'Show diff for file or all changes.',
    parameters: {
      type: 'object',
      properties: {
        path:   { type: 'string',  description: 'File (all if omitted)' },
        staged: { type: 'boolean', description: 'Staged changes (default: false)' },
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
];

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
      default:             return `Error: Unknown tool '${name}'`;
    }
  } catch (e) {
    return `Tool error (${name}): ${String(e)}`;
  }
}

import * as fs from 'fs';
import type { ToolDefinition } from '../providers/types.js';
import { auraPath } from '../util/aura-home.js';

// ─────────────────────────────────────────────────────────────────────────────
// MCP Client — connect to MCP servers for extended tool capabilities
// Model Context Protocol allows AI agents to use external tools like
// Chrome DevTools, databases, file systems, APIs, etc.
// ─────────────────────────────────────────────────────────────────────────────

export interface McpInput {
  action: 'connect' | 'disconnect' | 'list_tools' | 'call_tool' | 'list_servers';
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  command?: string;
  args_list?: string[];
}

export const MCP_DEFINITION: ToolDefinition = {
  name: 'mcp',
  description:
    'Connect to MCP (Model Context Protocol) servers for extended tool capabilities. ' +
    'MCP servers provide tools like Chrome DevTools control, database access, file system operations, etc. ' +
    'Actions: connect, disconnect, list_tools, call_tool, list_servers. ' +
    'Servers configured in ~/.aura/mcp.json connect by name alone (connect server=<name>, no command).',
  parameters: {
    type: 'object',
    properties: {
      action:    { type: 'string', description: 'Action: connect, disconnect, list_tools, call_tool, list_servers' },
      server:    { type: 'string', description: 'Server name or ID (for connect/disconnect/list_tools/call_tool)' },
      tool:      { type: 'string', description: 'Tool name to call (for call_tool action)' },
      args:      { type: 'object', description: 'Arguments for the tool call (for call_tool action)' },
      command:   { type: 'string', description: 'Command to start MCP server (for connect, e.g. "npx @anthropic-ai/mcp-server-puppeteer"). Omit for servers configured in ~/.aura/mcp.json' },
      args_list: { type: 'array',  description: 'Command arguments (for connect)', items: { type: 'string' } },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MCP Protocol Types
// ─────────────────────────────────────────────────────────────────────────────

interface McpServer {
  name: string;
  command: string;
  args: string[];
  process: import('child_process').ChildProcess | null;
  tools: McpToolInfo[];
  connected: boolean;
  requestId: number;
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  buffer: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Global registry of MCP servers
const mcpServers = new Map<string, McpServer>();

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 helpers (MCP uses JSON-RPC over stdio)
// ─────────────────────────────────────────────────────────────────────────────

// MCP stdio transport is newline-delimited JSON: one message per line, no
// embedded newlines (JSON.stringify never emits raw ones). This client used to
// send LSP-style Content-Length headers, which spec servers never parse — every
// connect to a real server timed out on `initialize`.
function frameMessage(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

export function parseJsonRpcMessages(data: string): { messages: any[]; remainder: string } {
  const messages: any[] = [];
  let remaining = data;

  while (true) {
    remaining = remaining.replace(/^\s+/, '');
    if (!remaining) break;

    // Tolerate Content-Length framed replies from older non-spec servers.
    if (/^Content-Length:/i.test(remaining)) {
      const headerEnd = remaining.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const lengthMatch = remaining.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
      const bodyStart = headerEnd + 4;
      const contentLength = lengthMatch ? parseInt(lengthMatch[1], 10) : 0;
      if (remaining.length < bodyStart + contentLength) break; // incomplete message
      try {
        messages.push(JSON.parse(remaining.slice(bodyStart, bodyStart + contentLength)));
      } catch {
        // skip malformed messages
      }
      remaining = remaining.slice(bodyStart + contentLength);
      continue;
    }

    const lineEnd = remaining.indexOf('\n');
    if (lineEnd === -1) break; // incomplete line — wait for more data
    const line = remaining.slice(0, lineEnd).trim();
    remaining = remaining.slice(lineEnd + 1);
    try {
      messages.push(JSON.parse(line));
    } catch {
      // not JSON-RPC (a server logging to stdout) — skip the line
    }
  }

  return { messages, remainder: remaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configured servers — ~/.aura/mcp.json
// Same {"mcpServers": {...}} shape Claude Code, Cursor and `summer setup
// --print` emit, so their snippets paste in unchanged. Config only supplies
// the command: nothing here connects. Connecting still goes through the
// `connect` action, so the permission screen and confirm prompt apply.
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args: string[];
}

/** Read per call (like auraPath itself), so an edited file applies without a restart. */
export function loadMcpConfig(): Map<string, McpServerConfig> {
  const servers = new Map<string, McpServerConfig>();
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(auraPath('mcp.json'), 'utf8'));
  } catch {
    return servers; // missing or unparseable file = no configured servers
  }
  const entries = raw?.mcpServers;
  if (!entries || typeof entries !== 'object') return servers;
  for (const [name, entry] of Object.entries(entries as Record<string, any>)) {
    // Only stdio servers: this client spawns a process, it has no HTTP transport.
    if (typeof entry?.command !== 'string' || !entry.command.trim()) continue;
    if (entry.type && entry.type !== 'stdio') continue;
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    servers.set(name, { command: entry.command, args });
  }
  return servers;
}

/**
 * The command a connect call will actually spawn: explicit input wins,
 * otherwise the configured entry for that server name. Shared with the
 * permission layer so the confirm prompt shows the real command.
 */
export function resolveConnectCommand(input: { server?: unknown; command?: unknown; args_list?: unknown }): McpServerConfig | null {
  if (typeof input.command === 'string' && input.command.trim()) {
    return { command: input.command, args: Array.isArray(input.args_list) ? input.args_list.map(String) : [] };
  }
  if (typeof input.server !== 'string') return null;
  return loadMcpConfig().get(input.server) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server management
// ─────────────────────────────────────────────────────────────────────────────

async function connectServer(name: string, command: string, cmdArgs: string[]): Promise<string> {
  if (mcpServers.has(name) && mcpServers.get(name)!.connected) {
    return `Already connected to MCP server: ${name}`;
  }

  const { spawn } = await import('child_process');

  return new Promise<string>((resolve, reject) => {
    try {
      const proc = spawn(command, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      const server: McpServer = {
        name,
        command,
        args: cmdArgs,
        process: proc,
        tools: [],
        connected: false,
        requestId: 0,
        pendingRequests: new Map(),
        buffer: '',
      };

      mcpServers.set(name, server);

      // Handle stdout (JSON-RPC responses)
      proc.stdout!.on('data', (chunk: Buffer) => {
        server.buffer += chunk.toString();
        const { messages, remainder } = parseJsonRpcMessages(server.buffer);
        server.buffer = remainder;

        for (const msg of messages) {
          if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
            const pending = server.pendingRequests.get(msg.id)!;
            server.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      });

      // Handle stderr (logging)
      proc.stderr!.on('data', () => {
        // MCP servers may log to stderr, ignore unless debugging
      });

      proc.on('error', (err: Error) => {
        server.connected = false;
        mcpServers.delete(name);
        reject(new Error(`MCP server process error: ${err.message}`));
      });

      proc.on('exit', (code: number | null) => {
        server.connected = false;
        // Reject all pending requests
        for (const [id, pending] of server.pendingRequests) {
          pending.reject(new Error(`MCP server exited with code ${code}`));
        }
        server.pendingRequests.clear();
      });

      // Send initialize request after a short delay to let process start
      setTimeout(async () => {
        try {
          // MCP initialize handshake
          const initResult = await sendRequest(server, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'aura-code', version: '0.3.0' },
          });

          // Send initialized notification
          sendNotification(server, 'notifications/initialized');

          server.connected = true;

          // Fetch available tools
          try {
            const toolsResult = await sendRequest(server, 'tools/list', {});
            if (toolsResult?.tools) {
              server.tools = toolsResult.tools.map((t: any) => ({
                name: t.name,
                description: t.description ?? '',
                inputSchema: t.inputSchema ?? {},
              }));
            }
          } catch {
            // Some servers may not support tools/list
          }

          resolve(`Connected to MCP server: ${name}\nServer: ${initResult?.serverInfo?.name ?? 'unknown'} ${initResult?.serverInfo?.version ?? ''}\nTools available: ${server.tools.length}`);
        } catch (err: any) {
          server.connected = false;
          resolve(`Warning: Connected to ${name} but initialization failed: ${err.message}`);
        }
      }, 500);

    } catch (err: any) {
      mcpServers.delete(name);
      reject(new Error(`Failed to start MCP server: ${err.message}`));
    }
  });
}

function sendRequest(server: McpServer, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!server.process?.stdin?.writable) {
      reject(new Error('Server process not running'));
      return;
    }

    const id = ++server.requestId;
    server.pendingRequests.set(id, { resolve, reject });

    const msg = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    server.process.stdin.write(frameMessage(msg));

    // Timeout after 30 seconds
    setTimeout(() => {
      if (server.pendingRequests.has(id)) {
        server.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }
    }, 30_000);
  });
}

function sendNotification(server: McpServer, method: string, params?: unknown): void {
  if (!server.process?.stdin?.writable) return;

  const msg = {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  };
  server.process.stdin.write(frameMessage(msg));
}

async function disconnectServer(name: string): Promise<string> {
  const server = mcpServers.get(name);
  if (!server) return `MCP server not found: ${name}`;

  if (server.process) {
    server.process.stdin?.end();
    server.process.kill('SIGTERM');
  }

  server.connected = false;
  mcpServers.delete(name);
  return `Disconnected from MCP server: ${name}`;
}

function listServers(): string {
  const idle = [...loadMcpConfig()].filter(([name]) => !mcpServers.get(name)?.connected);
  const idleLines = idle.length === 0 ? [] : [
    '\nConfigured in ~/.aura/mcp.json (not connected — mcp action=connect server=<name>):',
    ...idle.map(([name, c]) => `  ${name}: ${c.command} ${c.args.join(' ')}`.trimEnd()),
  ];

  if (mcpServers.size === 0) {
    return ['No MCP servers connected.\n\nTo connect: mcp action=connect server=<name> command="<command>" args_list=["arg1","arg2"]',
      ...idleLines].join('\n');
  }

  const lines: string[] = ['Connected MCP servers:'];
  for (const [name, server] of mcpServers) {
    const status = server.connected ? '✓ connected' : '✗ disconnected';
    lines.push(`\n  ${name} (${status})`);
    lines.push(`    Command: ${server.command} ${server.args.join(' ')}`);
    if (server.tools.length > 0) {
      lines.push(`    Tools (${server.tools.length}):`);
      server.tools.forEach(t => {
        lines.push(`      - ${t.name}: ${t.description.slice(0, 80)}`);
      });
    }
  }
  return [...lines, ...idleLines].join('\n');
}

function listTools(serverName: string): string {
  const server = mcpServers.get(serverName);
  if (!server) return `MCP server not found: ${serverName}`;
  if (!server.connected) return `MCP server not connected: ${serverName}`;
  if (server.tools.length === 0) return `No tools available on ${serverName}`;

  const lines = [`Tools on MCP server "${serverName}":`];
  server.tools.forEach((t, i) => {
    lines.push(`\n${i + 1}. ${t.name}`);
    lines.push(`   ${t.description}`);
    if (t.inputSchema?.properties) {
      const props = Object.entries(t.inputSchema.properties as Record<string, any>);
      if (props.length > 0) {
        lines.push(`   Parameters: ${props.map(([k, v]) => `${k} (${v.type ?? '?'})`).join(', ')}`);
      }
    }
  });
  return lines.join('\n');
}

async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const server = mcpServers.get(serverName);
  if (!server) return `MCP server not found: ${serverName}`;
  if (!server.connected) return `MCP server not connected: ${serverName}`;

  // The connect-time tools/list snapshot is an ALLOWLIST, not a courtesy
  // cache. The user's confirm-at-connect approval covered the tools that
  // existed then; this client deliberately ignores tools/list_changed, so a
  // server that expands its tool set post-connect cannot have the new tools
  // called — adopting them requires disconnect + connect, which re-prompts.
  // It also stops prompt-injected calls to hidden, never-advertised tools.
  // (Only enforceable when the server supported tools/list at connect.)
  if (server.tools.length > 0 && !server.tools.some(t => t.name === toolName)) {
    return `MCP tool '${toolName}' is not in ${serverName}'s connect-time tool list. ` +
      `Available: ${server.tools.map(t => t.name).join(', ')}. ` +
      `If the server added tools after connecting, disconnect and reconnect to re-approve it.`;
  }

  try {
    const result = await sendRequest(server, 'tools/call', {
      name: toolName,
      arguments: args,
    });

    // MCP returns content as array of {type, text} or {type, data, mimeType}
    if (result?.content) {
      const parts = result.content.map((c: any) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[Image: ${c.mimeType}, ${c.data?.length ?? 0} bytes base64]`;
        return `[${c.type} content]`;
      });
      return parts.join('\n');
    }

    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `MCP tool call error: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function mcpTool(input: McpInput): Promise<string> {
  try {
    switch (input.action) {
      case 'list_servers':
        return listServers();

      case 'connect': {
        if (!input.server) return 'Error: server name is required';
        const resolved = resolveConnectCommand(input);
        if (!resolved) {
          const configured = [...loadMcpConfig().keys()];
          return 'Error: command is required (e.g., "npx @anthropic-ai/mcp-server-puppeteer"), ' +
            `or configure "${input.server}" in ~/.aura/mcp.json` +
            (configured.length ? `. Configured: ${configured.join(', ')}` : '');
        }
        return await connectServer(input.server, resolved.command, resolved.args);
      }

      case 'disconnect': {
        if (!input.server) return 'Error: server name is required';
        return await disconnectServer(input.server);
      }

      case 'list_tools': {
        if (!input.server) return 'Error: server name is required';
        return listTools(input.server);
      }

      case 'call_tool': {
        if (!input.server) return 'Error: server name is required';
        if (!input.tool) return 'Error: tool name is required';
        return await callTool(input.server, input.tool, input.args ?? {});
      }

      default:
        return `Error: Unknown MCP action: ${input.action}`;
    }
  } catch (e: any) {
    return `MCP error (${input.action}): ${e?.message ?? String(e)}`;
  }
}

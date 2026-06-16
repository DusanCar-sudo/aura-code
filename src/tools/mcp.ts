import type { ToolDefinition } from '../providers/types.js';

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
    'Actions: connect, disconnect, list_tools, call_tool, list_servers.',
  parameters: {
    type: 'object',
    properties: {
      action:    { type: 'string', description: 'Action: connect, disconnect, list_tools, call_tool, list_servers' },
      server:    { type: 'string', description: 'Server name or ID (for connect/disconnect/list_tools/call_tool)' },
      tool:      { type: 'string', description: 'Tool name to call (for call_tool action)' },
      args:      { type: 'object', description: 'Arguments for the tool call (for call_tool action)' },
      command:   { type: 'string', description: 'Command to start MCP server (for connect, e.g. "npx @anthropic-ai/mcp-server-puppeteer")' },
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

function createJsonRpcMessage(method: string, params?: unknown): string {
  const msg = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    ...(params !== undefined ? { params } : {}),
  };
  const body = JSON.stringify(msg);
  // MCP uses Content-Length header framing
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function parseJsonRpcMessages(data: string): { messages: any[]; remainder: string } {
  const messages: any[] = [];
  let remaining = data;

  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = remaining.slice(0, headerEnd);
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) break;

    const contentLength = parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + 4;

    if (remaining.length < bodyStart + contentLength) break; // incomplete message

    const body = remaining.slice(bodyStart, bodyStart + contentLength);
    try {
      messages.push(JSON.parse(body));
    } catch {
      // skip malformed messages
    }

    remaining = remaining.slice(bodyStart + contentLength);
  }

  return { messages, remainder: remaining };
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
    const body = JSON.stringify(msg);
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    server.process.stdin.write(framed);

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
  const body = JSON.stringify(msg);
  const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

  server.process.stdin.write(framed);
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
  if (mcpServers.size === 0) {
    return 'No MCP servers connected.\n\nTo connect: mcp action=connect server=<name> command="<command>" args_list=["arg1","arg2"]';
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
  return lines.join('\n');
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
        if (!input.command) return 'Error: command is required (e.g., "npx @anthropic-ai/mcp-server-puppeteer")';
        return await connectServer(input.server, input.command, input.args_list ?? []);
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

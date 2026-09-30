#!/usr/bin/env node
/**
 * Aura's computer-use tool as an MCP server (stdio).
 *
 * Aura becomes the hands, any MCP client becomes the brain: Claude Code on a
 * Pro/Max subscription, for example, drives the screen through Aura's own
 * computer tool — the same gate, disclosure, sidecar and release hooks as
 * `aura --computer`. Nothing here moves the mouse by itself.
 *
 *   claude mcp add aura-computer -e AURA_COMPUTER_USE=1 -- aura-mcp-computer --computer
 *
 * Both halves of the gate are required, exactly as at `aura` startup: the
 * --computer flag (this process) and AURA_COMPUTER_USE=1 (its environment).
 * The machine acknowledgement is still checked on every call by computerTool.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout carries
 * protocol only — anything else printed there would corrupt the stream, so
 * diagnostics go to stderr.
 */

import * as readline from 'readline';
import { COMPUTER_DEFINITION, computerTool, setComputerUseEnabled, closeComputer } from '../tools/computer.js';
import { COMPUTER_USE_ENV } from '../tools/screen/disclosure.js';

const PROTOCOL_VERSION = '2025-06-18';

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** computerTool returns data: URLs; MCP wants bare base64 plus a mime type. */
export function toMcpContent(out: string | { text: string; images?: string[] }): McpContent[] {
  if (typeof out === 'string') return [{ type: 'text', text: out }];
  const content: McpContent[] = [{ type: 'text', text: out.text }];
  for (const url of out.images ?? []) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (m) content.push({ type: 'image', mimeType: m[1], data: m[2] });
  }
  return content;
}

export async function handle(msg: any): Promise<unknown | undefined> {
  const { id, method, params } = msg ?? {};
  if (id === undefined) return undefined; // notification — no reply

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'aura-computer', version: '1.0.0' },
        },
      };

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: {
          tools: [{
            name: COMPUTER_DEFINITION.name,
            description: COMPUTER_DEFINITION.description,
            inputSchema: COMPUTER_DEFINITION.parameters,
          }],
        },
      };

    case 'tools/call': {
      if (params?.name !== COMPUTER_DEFINITION.name) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
      }
      const out = await computerTool(params.arguments ?? {});
      const content = toMcpContent(out);
      const isError = content[0]?.type === 'text' && content[0].text.startsWith('Error:');
      return { jsonrpc: '2.0', id, result: { content, isError } };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

async function main(): Promise<void> {
  // The flag half of the gate. Without it every call is refused by
  // checkComputerUseGate — the server still starts, so the client sees the
  // refusal text (which says what to enable) instead of a dead process.
  if (process.argv.includes('--computer')) setComputerUseEnabled(true);
  if (!process.env[COMPUTER_USE_ENV]) {
    process.stderr.write(`aura-mcp-computer: ${COMPUTER_USE_ENV} is not set; every call will be refused.\n`);
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(msg)
      .then((reply) => { if (reply) send(reply); })
      .catch((e) => send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }));
  });
  // Client hung up: release the input device and portal session before exit.
  rl.on('close', () => { void closeComputer().finally(() => process.exit(0)); });
}

if (process.argv[1] && /mcp-computer\.(js|ts)$/.test(process.argv[1])) void main();

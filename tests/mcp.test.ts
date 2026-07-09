import { describe, it, expect, vi, afterEach } from 'vitest';
import { mcpTool, MCP_DEFINITION } from '../src/tools/mcp.js';

afterEach(() => {
  // Clean up any lingering MCP servers
});

describe('MCP_DEFINITION', () => {
  it('has correct name', () => expect(MCP_DEFINITION.name).toBe('mcp'));
  it('requires action', () => expect(MCP_DEFINITION.parameters.required).toEqual(['action']));
  it('has server property', () => expect(MCP_DEFINITION.parameters.properties.server).toBeDefined());
  it('has tool property', () => expect(MCP_DEFINITION.parameters.properties.tool).toBeDefined());
  it('has args property', () => expect(MCP_DEFINITION.parameters.properties.args).toBeDefined());
  it('has command property', () => expect(MCP_DEFINITION.parameters.properties.command).toBeDefined());
});

describe('mcpTool — list_servers', () => {
  it('returns no servers message when empty', async () => {
    const r = await mcpTool({ action: 'list_servers' });
    expect(r).toContain('No MCP servers connected');
    expect(r).toContain('mcp action=connect');
  });
});

describe('mcpTool — connect validation', () => {
  it('requires server name', async () => {
    const r = await mcpTool({ action: 'connect' });
    expect(r).toContain('Error');
    expect(r).toContain('server name is required');
  });

  it('requires command', async () => {
    const r = await mcpTool({ action: 'connect', server: 'test' });
    expect(r).toContain('Error');
    expect(r).toContain('command is required');
  });
});

describe('mcpTool — disconnect validation', () => {
  it('requires server name', async () => {
    const r = await mcpTool({ action: 'disconnect' });
    expect(r).toContain('Error');
    expect(r).toContain('server name is required');
  });

  it('returns not found for unknown server', async () => {
    const r = await mcpTool({ action: 'disconnect', server: 'nonexistent' });
    expect(r).toContain('not found');
  });
});

describe('mcpTool — list_tools validation', () => {
  it('requires server name', async () => {
    const r = await mcpTool({ action: 'list_tools' });
    expect(r).toContain('Error');
    expect(r).toContain('server name is required');
  });

  it('returns not found for unknown server', async () => {
    const r = await mcpTool({ action: 'list_tools', server: 'nonexistent' });
    expect(r).toContain('not found');
  });
});

describe('mcpTool — call_tool validation', () => {
  it('requires server name', async () => {
    const r = await mcpTool({ action: 'call_tool' });
    expect(r).toContain('Error');
    expect(r).toContain('server name is required');
  });

  it('requires tool name', async () => {
    const r = await mcpTool({ action: 'call_tool', server: 'test' });
    expect(r).toContain('Error');
    expect(r).toContain('tool name is required');
  });

  it('returns not found for unknown server', async () => {
    const r = await mcpTool({ action: 'call_tool', server: 'nonexistent', tool: 'test' });
    expect(r).toContain('not found');
  });
});

describe('mcpTool — unknown action', () => {
  it('returns error for unknown action', async () => {
    const r = await mcpTool({ action: 'unknown' as any });
    expect(r).toContain('Error');
    expect(r).toContain('Unknown MCP action');
  });
});

// ── Live allowlist enforcement against a fake stdio MCP server ──────────────
// The fake server advertises ONE tool ("echo") at connect, but happily
// accepts tools/call for anything — like a server that expands its tool set
// post-connect (tools/list_changed) or hides unadvertised tools. The client
// must treat the connect-time snapshot as an allowlist.

const FAKE_SERVER_JS = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  while (true) {
    const he = buf.indexOf('\\r\\n\\r\\n');
    if (he === -1) break;
    const m = buf.slice(0, he).match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buf = buf.slice(he + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length < he + 4 + len) break;
    const body = buf.slice(he + 4, he + 4 + len);
    buf = buf.slice(he + 4 + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id === undefined) continue; // notification
    let result;
    if (msg.method === 'initialize') result = { serverInfo: { name: 'fake', version: '1.0' } };
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }] };
    else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'called:' + msg.params.name }] };
    else result = {};
    const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    process.stdout.write('Content-Length: ' + Buffer.byteLength(out) + '\\r\\n\\r\\n' + out);
  }
});
`;

describe('mcpTool — connect-time tool snapshot is an allowlist', () => {
  afterEach(async () => {
    await mcpTool({ action: 'disconnect', server: 'fake' });
  });

  it('allows advertised tools and refuses never-advertised ones', async () => {
    const connect = await mcpTool({
      action: 'connect', server: 'fake',
      command: process.execPath, args_list: ['-e', FAKE_SERVER_JS],
    });
    expect(connect).toContain('Connected to MCP server: fake');
    expect(connect).toContain('Tools available: 1');

    // Advertised at connect → forwarded to the server.
    const ok = await mcpTool({ action: 'call_tool', server: 'fake', tool: 'echo', args: {} });
    expect(ok).toContain('called:echo');

    // Never advertised (e.g. added post-connect via tools/list_changed, or
    // hidden) → refused client-side even though the server would accept it.
    const refused = await mcpTool({ action: 'call_tool', server: 'fake', tool: 'delete_everything', args: {} });
    expect(refused).toContain("not in fake's connect-time tool list");
    expect(refused).toContain('disconnect and reconnect');
    expect(refused).not.toContain('called:');
  }, 15_000);
});

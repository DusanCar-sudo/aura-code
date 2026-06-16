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

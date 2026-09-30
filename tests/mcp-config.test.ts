import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mcpTool, loadMcpConfig, resolveConnectCommand } from '../src/tools/mcp.js';
import { PermissionSystem } from '../src/safety/permissions.js';

let home: string;
const prevHome = process.env.AURA_HOME;

function writeConfig(obj: unknown): void {
  fs.writeFileSync(path.join(home, 'mcp.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mcp-'));
  process.env.AURA_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AURA_HOME; else process.env.AURA_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const SUMMER = { mcpServers: { 'summer-engine': { type: 'stdio', command: 'npx', args: ['-y', 'summer-engine@latest', 'mcp'] } } };

describe('loadMcpConfig', () => {
  it('is empty when the file is missing', () => {
    expect(loadMcpConfig().size).toBe(0);
  });

  it('is empty (not throwing) on malformed JSON', () => {
    writeConfig('{ not json');
    expect(loadMcpConfig().size).toBe(0);
  });

  it('reads the snippet `summer setup --print` emits, unchanged', () => {
    writeConfig(SUMMER);
    expect(loadMcpConfig().get('summer-engine')).toEqual({ command: 'npx', args: ['-y', 'summer-engine@latest', 'mcp'] });
  });

  it('skips non-stdio and command-less entries', () => {
    writeConfig({ mcpServers: { web: { type: 'http', url: 'https://x' }, bad: { args: ['a'] }, ok: { command: 'srv' } } });
    expect([...loadMcpConfig().keys()]).toEqual(['ok']);
    expect(loadMcpConfig().get('ok')!.args).toEqual([]);
  });
});

describe('resolveConnectCommand', () => {
  it('prefers an explicit command over config', () => {
    writeConfig(SUMMER);
    expect(resolveConnectCommand({ server: 'summer-engine', command: 'other', args_list: ['x'] }))
      .toEqual({ command: 'other', args: ['x'] });
  });

  it('falls back to the configured entry by name', () => {
    writeConfig(SUMMER);
    expect(resolveConnectCommand({ server: 'summer-engine' })!.command).toBe('npx');
  });

  it('returns null for an unknown name', () => {
    writeConfig(SUMMER);
    expect(resolveConnectCommand({ server: 'nope' })).toBeNull();
  });
});

describe('mcpTool with config', () => {
  it('connect by unknown name names the config file and lists configured servers', async () => {
    writeConfig(SUMMER);
    const r = await mcpTool({ action: 'connect', server: 'nope' });
    expect(r).toContain('command is required');
    expect(r).toContain('~/.aura/mcp.json');
    expect(r).toContain('Configured: summer-engine');
  });

  it('list_servers shows configured-but-idle servers', async () => {
    writeConfig(SUMMER);
    const r = await mcpTool({ action: 'list_servers' });
    expect(r).toContain('No MCP servers connected');
    expect(r).toContain('summer-engine: npx -y summer-engine@latest mcp');
  });
});

describe('permissions screen the resolved command', () => {
  it('a name-only connect is still confirm-gated', () => {
    writeConfig(SUMMER);
    const pm = new PermissionSystem('normal');
    const d = pm.check('mcp', { action: 'connect', server: 'summer-engine' });
    expect(d.allowed).toBe(true);
    expect(d.needsConfirm).toBe(true);
  });

  it('a dangerous command hidden in config is blocked on name-only connect', () => {
    writeConfig({ mcpServers: { evil: { command: 'rm', args: ['-rf', '/'] } } });
    const pm = new PermissionSystem('auto');
    expect(pm.check('mcp', { action: 'connect', server: 'evil' }).allowed).toBe(false);
  });
});

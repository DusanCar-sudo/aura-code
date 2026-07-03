import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addMarketplace, listMarketplaces, removeMarketplace,
  installPlugin, removePlugin,
} from '../src/plugins/market.js';
import { loadAllPlugins } from '../src/plugins/loader.js';

describe('plugin marketplace', () => {
  let base: string;

  function writeTree(root: string, files: Record<string, string>): string {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return root;
  }

  /** A local git repo works as a clone source — keeps tests offline. */
  function gitify(dir: string): void {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    execFileSync('git', ['add', '-A'], { cwd: dir, env });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-market-test-'));
    process.env.AURA_PLUGIN_DIR = path.join(base, 'plugins');
    process.env.AURA_MARKETPLACE_DIR = path.join(base, 'marketplaces');
  });

  afterEach(() => {
    delete process.env.AURA_PLUGIN_DIR;
    delete process.env.AURA_MARKETPLACE_DIR;
    fs.rmSync(base, { recursive: true, force: true });
  });

  function makeMarketplaceRepo(): string {
    const repo = path.join(base, 'market-src');
    writeTree(repo, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'test-market',
        description: 'Fixture marketplace',
        plugins: [
          { name: 'greeter', description: 'says hi', source: './plugins/greeter' },
          { name: 'remote-one', source: 'someone/some-repo' },
        ],
      }),
      'plugins/greeter/.claude-plugin/plugin.json': JSON.stringify({ name: 'greeter', version: '2.0.0' }),
      'plugins/greeter/commands/hello.md': '---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.',
    });
    gitify(repo);
    return repo;
  }

  it('adds a marketplace from a local git repo and lists it', async () => {
    const market = await addMarketplace(makeMarketplaceRepo());
    expect(market.name).toBe('test-market');
    expect(market.plugins.map(p => p.name)).toEqual(['greeter', 'remote-one']);

    const listed = listMarketplaces();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('test-market');
    expect(listed[0].description).toBe('Fixture marketplace');
  });

  it('rejects a repo without marketplace.json', async () => {
    const repo = writeTree(path.join(base, 'not-market'), { 'readme.md': 'x' });
    gitify(repo);
    await expect(addMarketplace(repo)).rejects.toThrow(/marketplace\.json/);
  });

  it('installs a plugin from a marketplace by name@marketplace', async () => {
    await addMarketplace(makeMarketplaceRepo());
    const { plugin, warnings } = await installPlugin('greeter@test-market');
    expect(plugin.name).toBe('greeter');
    expect(plugin.manifest.version).toBe('2.0.0');
    expect(plugin.commands.map(c => c.name)).toEqual(['hello']);
    expect(warnings).toEqual([]);

    expect(loadAllPlugins().map(p => p.name)).toEqual(['greeter']);
  });

  it('installs by bare name when exactly one marketplace has it', async () => {
    await addMarketplace(makeMarketplaceRepo());
    const { plugin } = await installPlugin('greeter');
    expect(plugin.name).toBe('greeter');
  });

  it('fails clearly for unknown plugins and unregistered marketplaces', async () => {
    await addMarketplace(makeMarketplaceRepo());
    await expect(installPlugin('nope@test-market')).rejects.toThrow(/not found/);
    await expect(installPlugin('greeter@ghost-market')).rejects.toThrow(/not registered/);
  });

  it('installs a plugin directly from a local directory', async () => {
    const dir = writeTree(path.join(base, 'local-plugin'), {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'local-thing' }),
      'commands/go.md': 'Go.',
      '.mcp.json': JSON.stringify({ mcpServers: { srv: {} } }),
    });
    const { plugin, warnings } = await installPlugin(dir);
    expect(plugin.name).toBe('local-thing');
    expect(warnings[0]).toContain('MCP server');
  });

  it('installs a plugin from a local git repo URL (clone path)', async () => {
    const repo = writeTree(path.join(base, 'plugin-repo.git-src'), {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'cloned-plugin' }),
      'agents/helper.md': 'You help.',
    });
    gitify(repo);
    // A path that exists is treated as a directory install; force the git
    // path by using a file:// URL.
    const { plugin } = await installPlugin(`file://${repo}`);
    expect(plugin.name).toBe('cloned-plugin');
    expect(plugin.agents).toHaveLength(1);
    // Installed copy is a plain directory, not a git checkout
    expect(fs.existsSync(path.join(plugin.path, '.git'))).toBe(false);
  });

  it('rejects installing a directory that is not a plugin', async () => {
    const dir = writeTree(path.join(base, 'empty-ish'), { 'x.txt': 'x' });
    await expect(installPlugin(dir)).rejects.toThrow(/no plugin/);
  });

  it('reinstalling replaces the previous copy', async () => {
    const dir = writeTree(path.join(base, 'v1'), {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'thing', version: '1.0.0' }),
      'commands/a.md': 'A',
    });
    await installPlugin(dir);
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'thing', version: '1.1.0' }));
    const { plugin } = await installPlugin(dir);
    expect(plugin.manifest.version).toBe('1.1.0');
    expect(loadAllPlugins()).toHaveLength(1);
  });

  it('removes plugins and marketplaces', async () => {
    await addMarketplace(makeMarketplaceRepo());
    await installPlugin('greeter@test-market');
    expect(removePlugin('greeter')).toBe(true);
    expect(removePlugin('greeter')).toBe(false);
    expect(loadAllPlugins()).toEqual([]);
    expect(removeMarketplace('test-market')).toBe(true);
    expect(listMarketplaces()).toEqual([]);
  });

  it('blocks marketplace entries whose path escapes the repo', async () => {
    const repo = path.join(base, 'evil-market');
    writeTree(repo, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'evil',
        plugins: [{ name: 'escape', source: '../../outside' }],
      }),
    });
    gitify(repo);
    await addMarketplace(repo);
    await expect(installPlugin('escape@evil')).rejects.toThrow(/escapes/);
  });
});

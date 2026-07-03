import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFrontmatter } from '../src/plugins/frontmatter.js';
import { loadPlugin, loadAllPlugins, pluginsDir } from '../src/plugins/loader.js';

describe('parseFrontmatter', () => {
  it('parses scalars, quotes, booleans, and numbers', () => {
    const { data, body } = parseFrontmatter(
      '---\ndescription: Review a PR\nname: "quoted name"\nenabled: true\ntimeout: 30\n---\nBody text',
    );
    expect(data.description).toBe('Review a PR');
    expect(data.name).toBe('quoted name');
    expect(data.enabled).toBe(true);
    expect(data.timeout).toBe(30);
    expect(body).toBe('Body text');
  });

  it('parses inline and block arrays', () => {
    const { data } = parseFrontmatter(
      '---\ntools: [Read, Grep, Bash]\nmodels:\n  - sonnet\n  - haiku\n---\nx',
    );
    expect(data.tools).toEqual(['Read', 'Grep', 'Bash']);
    expect(data.models).toEqual(['sonnet', 'haiku']);
  });

  it('returns the whole content as body when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('Just a prompt.\nNo fences.');
    expect(data).toEqual({});
    expect(body).toBe('Just a prompt.\nNo fences.');
  });

  it('handles CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\ndescription: hi\r\n---\r\nbody');
    expect(data.description).toBe('hi');
    expect(body).toBe('body');
  });
});

describe('plugin loader', () => {
  let base: string;

  function writePlugin(name: string, files: Record<string, string>): string {
    const dir = path.join(base, name);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-plugins-'));
    process.env.AURA_PLUGIN_DIR = base;
  });

  afterEach(() => {
    delete process.env.AURA_PLUGIN_DIR;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('pluginsDir honors AURA_PLUGIN_DIR', () => {
    expect(pluginsDir()).toBe(base);
  });

  it('loads manifest, commands, agents, skills, and hooks', () => {
    const dir = writePlugin('pr-tools', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'pr-tools', version: '1.0.0', description: 'PR helpers' }),
      'commands/review.md': '---\ndescription: Review a PR\nargument-hint: "[pr-number]"\n---\nReview PR $1 carefully.',
      'commands/git/commit.md': 'Write a commit for: $ARGUMENTS',
      'agents/security-reviewer.md': '---\nname: security-reviewer\ndescription: Security specialist\n---\nYou are a security reviewer.',
      'skills/tdd/SKILL.md': '---\nname: tdd\ndescription: Test-driven development\n---\nAlways write the test first.',
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }],
          PostToolUse: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo ignored-event' }] }],
        },
      }),
    });

    const plugin = loadPlugin(dir)!;
    expect(plugin.name).toBe('pr-tools');
    expect(plugin.manifest.version).toBe('1.0.0');

    expect(plugin.commands.map(c => c.name).sort()).toEqual(['git:commit', 'review']);
    const review = plugin.commands.find(c => c.name === 'review')!;
    expect(review.description).toBe('Review a PR');
    expect(review.argumentHint).toBe('[pr-number]');
    expect(review.body).toBe('Review PR $1 carefully.');

    expect(plugin.agents).toHaveLength(1);
    expect(plugin.agents[0].name).toBe('security-reviewer');
    expect(plugin.agents[0].systemPrompt).toBe('You are a security reviewer.');

    expect(plugin.skills).toHaveLength(1);
    expect(plugin.skills[0].name).toBe('tdd');

    // Unsupported events dropped; supported ones flattened with plugin root
    expect(plugin.hooks).toHaveLength(2);
    const pre = plugin.hooks.find(h => h.event === 'PreToolUse')!;
    expect(pre.matcher).toBe('Bash');
    expect(pre.timeout).toBe(5);
    expect(pre.pluginRoot).toBe(dir);
  });

  it('falls back to the directory name when the manifest is missing', () => {
    const dir = writePlugin('bare-plugin', {
      'commands/hello.md': 'Say hello.',
    });
    const plugin = loadPlugin(dir)!;
    expect(plugin.name).toBe('bare-plugin');
    expect(plugin.commands).toHaveLength(1);
  });

  it('returns null for a directory with no plugin content', () => {
    const dir = writePlugin('not-a-plugin', { 'readme.txt': 'nothing here' });
    expect(loadPlugin(dir)).toBeNull();
  });

  it('counts MCP servers without loading them', () => {
    const dir = writePlugin('mcp-heavy', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'mcp-heavy' }),
      '.mcp.json': JSON.stringify({ mcpServers: { a: {}, b: {} } }),
    });
    expect(loadPlugin(dir)!.mcpServerCount).toBe(2);
  });

  it('survives malformed files without throwing', () => {
    const dir = writePlugin('broken', {
      '.claude-plugin/plugin.json': '{not json',
      'commands/ok.md': 'Works.',
      'hooks/hooks.json': 'also not json',
    });
    const plugin = loadPlugin(dir)!;
    expect(plugin.name).toBe('broken');
    expect(plugin.commands).toHaveLength(1);
    expect(plugin.hooks).toEqual([]);
  });

  it('loadAllPlugins scans the plugins dir and skips non-plugins', () => {
    writePlugin('one', { 'commands/a.md': 'A' });
    writePlugin('two', { 'commands/b.md': 'B' });
    writePlugin('junk', { 'notes.txt': 'x' });
    const all = loadAllPlugins();
    expect(all.map(p => p.name)).toEqual(['one', 'two']);
  });

  it('loadAllPlugins returns [] when the dir does not exist', () => {
    process.env.AURA_PLUGIN_DIR = path.join(base, 'missing');
    expect(loadAllPlugins()).toEqual([]);
  });
});

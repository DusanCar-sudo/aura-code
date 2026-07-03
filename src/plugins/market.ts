/**
 * Plugin marketplaces & installation — Claude Code compatible.
 *
 * A marketplace is a git repo containing .claude-plugin/marketplace.json:
 *   { "name": "...", "owner": {...}, "plugins": [ {"name", "source", ...} ] }
 *
 * Sources we resolve (the formats found across published marketplaces):
 *   "./plugins/foo"                          — path inside the marketplace repo
 *   "owner/repo"                             — GitHub shorthand
 *   "https://…/repo.git"                     — any git URL
 *   { "source": "github", "repo": "o/r" }    — object form
 *   { "source": "git",    "url": "…" }
 *   { "source": "path"|"local", "path": "…" }— path inside the marketplace repo
 *
 * Layout on disk:
 *   ~/.aura/marketplaces/<name>   — cloned marketplace repos
 *   ~/.aura/plugins/<name>        — installed plugins (self-contained copies)
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { marketplacesDir, pluginsDir, loadPlugin } from './loader.js';
import type { LoadedPlugin, Marketplace, MarketplacePluginEntry } from './types.js';

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

function gitUrlFor(source: string): string | null {
  if (/^(https?|git|ssh|file):\/\//.test(source) || source.endsWith('.git')) return source;
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}.git`;
  return null;
}

async function cloneTo(url: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run('git', ['clone', '--depth', '1', '--quiet', url, dest]);
  // The clone is a snapshot install, not a working checkout — drop .git so
  // installed plugins are plain directories (update = reinstall).
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplaces
// ─────────────────────────────────────────────────────────────────────────────

function readMarketplaceJson(dir: string): { name: string; description?: string; plugins: MarketplacePluginEntry[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
    if (typeof raw?.name !== 'string') return null;
    const plugins: MarketplacePluginEntry[] = Array.isArray(raw.plugins)
      ? raw.plugins
          .filter((p: unknown): p is Record<string, unknown> =>
            typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>).name === 'string')
          .map((p: Record<string, unknown>) => ({
            name: p.name as string,
            description: typeof p.description === 'string' ? p.description : undefined,
            source: p.source,
          }))
      : [];
    return { name: raw.name, description: typeof raw.description === 'string' ? raw.description : undefined, plugins };
  } catch {
    return null;
  }
}

/**
 * Register a marketplace from a GitHub shorthand, git URL, or local path.
 * Returns the loaded marketplace.
 */
export async function addMarketplace(source: string): Promise<Marketplace> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-market-'));
  const staging = path.join(tmp, 'repo');
  try {
    const url = gitUrlFor(source);
    if (url && !fs.existsSync(source)) {
      await cloneTo(url, staging);
    } else if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
      copyDir(path.resolve(source), staging);
    } else {
      throw new Error(`Not a git repo shorthand, URL, or local directory: ${source}`);
    }

    const meta = readMarketplaceJson(staging);
    if (!meta) {
      throw new Error('No valid .claude-plugin/marketplace.json found — is this a marketplace repo? (To install a single plugin, use: aura --plugin install <source>)');
    }

    const dest = path.join(marketplacesDir(), meta.name);
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(staging, dest);
    return { name: meta.name, path: dest, description: meta.description, plugins: meta.plugins };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function listMarketplaces(): Marketplace[] {
  const dir = marketplacesDir();
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out: Marketplace[] = [];
  for (const entry of entries.sort()) {
    const mDir = path.join(dir, entry);
    const meta = readMarketplaceJson(mDir);
    if (meta) out.push({ name: meta.name, path: mDir, description: meta.description, plugins: meta.plugins });
  }
  return out;
}

export function removeMarketplace(name: string): boolean {
  const dir = path.join(marketplacesDir(), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin install / remove
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallResult {
  plugin: LoadedPlugin;
  /** Notes worth surfacing (e.g. unsupported MCP servers). */
  warnings: string[];
}

/**
 * Install a plugin. Accepted specs:
 *   "name@marketplace"  — from a registered marketplace
 *   "name"              — from any registered marketplace that has it
 *   "owner/repo"        — GitHub repo containing a plugin
 *   git URL             — same
 *   local path          — directory containing a plugin
 */
export async function installPlugin(spec: string): Promise<InstallResult> {
  // name@marketplace / bare marketplace name
  const at = spec.indexOf('@');
  if (at > 0 || (!spec.includes('/') && !fs.existsSync(spec))) {
    const pluginName = at > 0 ? spec.slice(0, at) : spec;
    const marketName = at > 0 ? spec.slice(at + 1) : undefined;
    return installFromMarketplace(pluginName, marketName);
  }

  // Local path
  if (fs.existsSync(spec) && fs.statSync(spec).isDirectory()) {
    return finalizeInstall(path.resolve(spec), 'copy');
  }

  // GitHub shorthand or git URL
  const url = gitUrlFor(spec);
  if (!url) throw new Error(`Unrecognized plugin source: ${spec}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-plugin-'));
  try {
    const staging = path.join(tmp, 'repo');
    await cloneTo(url, staging);
    return finalizeInstall(staging, 'move');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installFromMarketplace(pluginName: string, marketName?: string): Promise<InstallResult> {
  const markets = listMarketplaces();
  if (markets.length === 0) {
    throw new Error('No marketplaces registered. Add one first: aura --plugin marketplace add <owner/repo>');
  }

  const candidates = markets
    .filter(m => !marketName || m.name === marketName)
    .map(m => ({ market: m, entry: m.plugins.find(p => p.name === pluginName) }))
    .filter((c): c is { market: Marketplace; entry: MarketplacePluginEntry } => !!c.entry);

  if (marketName && !markets.some(m => m.name === marketName)) {
    throw new Error(`Marketplace not registered: ${marketName}`);
  }
  if (candidates.length === 0) {
    throw new Error(`Plugin "${pluginName}" not found in ${marketName ?? 'any registered marketplace'}.`);
  }
  if (candidates.length > 1) {
    throw new Error(`Plugin "${pluginName}" exists in multiple marketplaces (${candidates.map(c => c.market.name).join(', ')}) — use name@marketplace.`);
  }

  const { market, entry } = candidates[0];
  const src = entry.source;

  // Path inside the marketplace repo (string "./…" or object {source: path|local})
  const relPath =
    typeof src === 'string' && !gitUrlFor(src) ? src
    : typeof src === 'object' && src !== null && ['path', 'local'].includes(String((src as Record<string, unknown>).source))
      ? String((src as Record<string, unknown>).path ?? '')
      : null;
  if (relPath) {
    const abs = path.resolve(market.path, relPath);
    if (!abs.startsWith(fs.realpathSync(market.path) + path.sep) && abs !== fs.realpathSync(market.path)) {
      throw new Error(`Marketplace entry escapes its repo: ${relPath}`);
    }
    if (!fs.existsSync(abs)) throw new Error(`Marketplace entry path missing: ${relPath}`);
    return finalizeInstall(abs, 'copy', pluginName);
  }

  // Remote source: "owner/repo" string, {source: github, repo}, {source: git|url, url}
  const url =
    typeof src === 'string' ? gitUrlFor(src)
    : typeof src === 'object' && src !== null
      ? gitUrlFor(String((src as Record<string, unknown>).repo ?? (src as Record<string, unknown>).url ?? ''))
      : null;
  if (!url) throw new Error(`Unsupported source format for "${pluginName}" in marketplace ${market.name}.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-plugin-'));
  try {
    const staging = path.join(tmp, 'repo');
    await cloneTo(url, staging);
    return finalizeInstall(staging, 'move', pluginName);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Validate the staged plugin, copy it into pluginsDir under its real name. */
function finalizeInstall(stagingDir: string, mode: 'copy' | 'move', fallbackName?: string): InstallResult {
  const probe = loadPlugin(stagingDir);
  if (!probe) {
    throw new Error('Directory contains no plugin (no .claude-plugin/plugin.json, commands/, agents/, skills/, or hooks/).');
  }
  const name = probe.manifest.name ?? fallbackName ?? path.basename(stagingDir);
  const dest = path.join(pluginsDir(), name);
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(stagingDir, dest);

  const plugin = loadPlugin(dest)!;
  const warnings: string[] = [];
  if (plugin.mcpServerCount > 0) {
    warnings.push(`declares ${plugin.mcpServerCount} MCP server(s) — aura has no MCP client yet, those are ignored.`);
  }
  return { plugin, warnings };
}

export function removePlugin(name: string): boolean {
  const dir = path.join(pluginsDir(), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

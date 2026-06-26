import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { IGNORE_PATTERNS } from '../config/defaults.js';

export interface ProjectContext {
  root: string;          // absolute path
  name: string;          // folder name / package name
  language: string;      // primary language detected
  framework: string;     // framework detected (React, Django, etc.)
  readme: string;        // README contents (truncated)
  tree: string;          // directory tree
  config: string;        // package.json / requirements.txt / Cargo.toml
  recentCommits: string; // last 5 git commits
  graphSummary?: string; // top nodes from graphify-out/graph.json, if present
  /** Reconciled memory from dreams/.reconciled.md — the agent's current
   *  beliefs about this project, distilled from past work sessions.
   *  Truncated to ~2000 chars to stay within token budget. */
  reconciledMemory?: string;
}

export async function loadProjectContext(cwd: string): Promise<ProjectContext> {
  const root = path.resolve(cwd);
  const name = detectProjectName(root);
  const { language, framework } = detectStack(root);

  return {
    root,
    name,
    language,
    framework,
    readme:            readTruncated(root, ['README.md', 'README.txt', 'README.rst'], 2000),
    tree:              buildTree(root),
    config:            readConfig(root),
    recentCommits:     readGitLog(root),
    graphSummary:      loadGraphSummary(root),
    reconciledMemory:  loadReconciledMemory(root),
  };
}

export function loadGraphSummary(root: string): string | undefined {
  const graphPath = path.join(root, 'graphify-out', 'graph.json');
  if (!fs.existsSync(graphPath)) return undefined;
  try {
    const raw = fs.readFileSync(graphPath, 'utf8');
    const graph = JSON.parse(raw) as {
      nodes?: Array<{ id: string; label?: string; summary?: string; type?: string; file?: string }>;
    };
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return undefined;
    const top = graph.nodes.slice(0, 40);
    const lines = top.map(n => {
      const loc = n.file ? ` (${n.file})` : '';
      const summary = n.summary ? `: ${n.summary.slice(0, 120)}` : '';
      return `  ${n.type ?? 'node'} ${n.label ?? n.id}${loc}${summary}`;
    });
    return `Top ${top.length} of ${graph.nodes.length} nodes:\n${lines.join('\n')}`;
  } catch {
    return undefined;
  }
}

/**
 * Load the reconciled memory projection from `dreams/.reconciled.md`.
 *
 * This file is written by the dream reconciliation system (reconcile.ts)
 * after ≥3 dreams exist. It contains the agent's current distilled beliefs
 * about the project — lessons, patterns, open threads — with annotations
 * showing where each belief came from and how it evolved.
 *
 * Returns undefined if the file doesn't exist (no dreams yet, or <3 dreams).
 * Truncates at 2000 chars to keep the system prompt within token budget.
 */
function loadReconciledMemory(root: string): string | undefined {
  const reconciledPath = path.join(root, 'dreams', '.reconciled.md');
  if (!fs.existsSync(reconciledPath)) return undefined;
  try {
    const raw = fs.readFileSync(reconciledPath, 'utf8');
    if (!raw.trim()) return undefined;
    // Strip YAML frontmatter for the prompt (metadata is useful for :rem
    // display but wastes tokens in the system prompt).
    let content = raw;
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx > 0) {
        content = content.slice(endIdx + 3).trim();
      }
    }
    if (content.length > 2000) {
      content = content.slice(0, 2000) + '\n\n[...truncated]';
    }
    return content;
  } catch {
    return undefined;
  }
}

function detectProjectName(root: string): string {
  // Try package.json
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(pkg)) {
    try { return JSON.parse(fs.readFileSync(pkg, 'utf8')).name ?? path.basename(root); }
    catch { /* fallthrough */ }
  }
  return path.basename(root);
}

function detectStack(root: string): { language: string; framework: string } {
  if (fs.existsSync(path.join(root, 'package.json'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
      const fw =
        deps.next ? 'Next.js' :
        deps.react ? 'React' :
        deps.vue ? 'Vue' :
        deps.express || deps.fastify ? 'Node.js API' :
        deps.electron ? 'Electron' :
        deps['@tauri-apps/cli'] ? 'Tauri' : 'Node.js';
      const lang = deps.typescript || p.scripts?.build?.includes('tsc') ? 'TypeScript' : 'JavaScript';
      return { language: lang, framework: fw };
    } catch { /* fallthrough */ }
  }
  if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) {
    return { language: 'Python', framework: 'Python' };
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return { language: 'Rust', framework: 'Rust' };
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    return { language: 'Go', framework: 'Go' };
  }
  return { language: 'Unknown', framework: 'Unknown' };
}

function readTruncated(root: string, names: string[], maxChars: number): string {
  for (const name of names) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        return content.length > maxChars
          ? content.slice(0, maxChars) + '\n\n[...truncated]'
          : content;
      } catch { /* next */ }
    }
  }
  return '(no README found)';
}

function buildTree(root: string): string {
  const lines: string[] = [path.basename(root) + '/'];
  function walk(dir: string, prefix: string, depth: number) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    const filtered = entries.filter(e =>
      !IGNORE_PATTERNS.some(p => e.name === p || (p.startsWith('*') && e.name.endsWith(p.slice(1))))
      && !e.name.startsWith('.')
    );
    filtered.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i];
      const last = i === filtered.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + (last ? '    ' : '│   '), depth + 1);
    }
  }
  walk(root, '', 1);
  return lines.join('\n');
}

function readConfig(root: string): string {
  for (const name of ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pyproject.toml']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        return `${name}:\n${content.slice(0, 1500)}${content.length > 1500 ? '\n[...truncated]' : ''}`;
      } catch { /* next */ }
    }
  }
  return '(no config file found)';
}

function readGitLog(root: string): string {
  try {
    return execSync('git log --oneline -10', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '(not a git repository)';
  }
}

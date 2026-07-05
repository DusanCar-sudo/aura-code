#!/usr/bin/env node
/**
 * Rebuild graphify-out/graph.json from the current codebase.
 * Scans .ts/.js/.mjs files, extracts imports/requires, and builds
 * a node-edge graph with file, module, and concept (external) nodes.
 *
 * Usage: node graphify-out/rebuild-graph.mjs [project-root]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { join, relative, dirname, basename, extname, resolve } from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.cache', '.openclaude',
  '.qwen', '.aura', 'graphify-out', 'hong-thuan-videos', 'my-project',
  'packaging', 'deploy', 'assets', 'google-cloud-sdk',
]);
const SKIP_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.mp3', '.mp4', '.pdf', '.pptx', '.zip', '.lock']);
const SCAN_EXTS = new Set(['.ts', '.js', '.mjs', '.json', '.md']);

const root = resolve(process.argv[2] || '.');
console.log(`Scanning ${root} …`);

// ─── Collect files ───────────────────────────────────────────────────────────
const files = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      if (ext === '.ts' && e.name.endsWith('.d.ts')) continue;
      if (SCAN_EXTS.has(ext)) files.push(full);
    }
  }
}
walk(root);

console.log(`  Found ${files.length} files`);

// ─── Parse imports ──────────────────────────────────────────────────────────
const IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;

const nodes = new Map();   // id → node
const edges = [];          // { source, target, relation }
const moduleDirs = new Set();

function relPath(abs) {
  return relative(root, abs);
}

function addNode(id, node) {
  if (!nodes.has(id)) nodes.set(id, { id, ...node });
}

for (const abs of files) {
  const rel = relPath(abs);
  const ext = extname(rel);

  // File node
  addNode(rel, {
    label: rel,
    type: 'file',
    file: rel,
    summary: `Source file: ${rel}`,
  });

  // Module directory node
  const dir = dirname(rel);
  if (dir !== '.' && !moduleDirs.has(dir)) {
    moduleDirs.add(dir);
    addNode(`mod:${dir}`, {
      label: `${dir}/`,
      type: 'file',
      summary: `Module directory: ${dir}/`,
    });
  }

  // Parse imports from code files
  if (ext === '.ts' || ext === '.js' || ext === '.mjs') {
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }

    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;

      if (spec.startsWith('.') || spec.startsWith('/')) {
        // Local import — resolve relative to file
        const dirOf = dirname(abs);
        let targetAbs = resolve(dirOf, spec);
        // Strip .js/.mjs extension to try .ts mapping
        const specExt = extname(targetAbs);
        const stripped = specExt ? targetAbs.slice(0, -specExt.length) : targetAbs;
        // Try extensions: exact, .ts, .js, index variants
        const candidates = [
          targetAbs,
          stripped + '.ts', stripped + '.js',
          join(targetAbs, 'index.ts'), join(targetAbs, 'index.js'),
          join(stripped, 'index.ts'), join(stripped, 'index.js'),
        ];
        const resolved = candidates.find(c => {
          try { return statSync(c).isFile(); } catch { return false; }
        });
        if (resolved) {
          const targetRel = relPath(resolved);
          addNode(targetRel, {
            label: targetRel,
            type: 'file',
            file: targetRel,
            summary: `Source file: ${targetRel}`,
          });
          edges.push({ source: rel, target: targetRel, relation: 'depends_on' });
        }
      } else {
        // External/npm concept
        const pkgName = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0];
        const conceptId = `npm:${pkgName}`;
        addNode(conceptId, {
          label: pkgName,
          type: 'concept',
          summary: `External npm package: ${pkgName}`,
        });
        edges.push({ source: rel, target: conceptId, relation: 'depends_on' });
      }
    }
  }
}

// ─── Build decision node (project-level) ────────────────────────────────────
let readme = '';
try { readme = readFileSync(join(root, 'README.md'), 'utf8').slice(0, 500); } catch {}
addNode('decision:architecture', {
  label: 'Architecture decisions',
  type: 'decision',
  summary: readme ? readme.split('\n').filter(l => l.trim()).slice(0, 3).join(' | ') : 'Project architecture',
});

// ─── Write output ───────────────────────────────────────────────────────────
const graph = {
  nodes: Array.from(nodes.values()),
  edges,
};

const outDir = join(root, 'graphify-out');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'graph.json');
writeFileSync(outPath, JSON.stringify(graph, null, 2), 'utf8');

console.log(`  ✓ ${graph.nodes.length} nodes, ${graph.edges.length} edges → ${outPath}`);

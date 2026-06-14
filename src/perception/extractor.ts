import * as fs from 'fs';
import * as path from 'path';
import { IGNORE_PATTERNS } from '../config/defaults.js';
import type { ProjectPerception, ArchitectureNode, ArchitectureEdge } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the project at `projectRoot` and build a full ProjectPerception snapshot.
 * Reads the directory tree, parses imports and comments from every .ts/.js file,
 * and extracts auxiliary information from README, CHANGELOG, config files, etc.
 */
export async function extractPerception(projectRoot: string): Promise<ProjectPerception> {
  const root = path.resolve(projectRoot);
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  const seenModules = new Set<string>();
  const extDepIds = new Set<string>();
  const fileSet = new Set<string>();

  // ── 1. Walk directory for .ts / .js files ──────────────────────────────────
  const files = walkFiles(root);
  const importCounts = new Map<string, number>(); // file -> how many files import it
  const deprecationIds: string[] = [];
  const riskAreas: string[] = [];
  const todoFragments: string[] = [];

  // ── 2. Parse each file ─────────────────────────────────────────────────────
  for (const rel of files) {
    const abs = path.join(root, rel);
    fileSet.add(rel);
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch { continue; }

    nodes.push(buildFileNode(rel));

    // Parse imports → depends_on edges
    const imports = parseImports(rel, content);
    for (const imp of imports) {
      if (imp.isExternal) {
        const depId = `npm:${imp.name}`;
        if (!extDepIds.has(depId)) {
          extDepIds.add(depId);
          nodes.push(buildDepNode(imp.name));
        }
        edges.push(buildEdge(rel, depId, 'depends_on', 0.9));
      } else {
        const resolved = resolveRelativeImport(root, rel, imp.name);
        if (resolved) {
          edges.push(buildEdge(rel, resolved, 'depends_on', 0.95));
          importCounts.set(resolved, (importCounts.get(resolved) ?? 0) + 1);
        }
      }
    }

    // Parse comments → TODO / FIXME / DEPRECATED / @architecture
    const comments = parseComments(content);
    for (const c of comments) {
      if (c.type === 'deprecated') deprecationIds.push(rel);
      if (c.type === 'todo' || c.type === 'fixme') {
        riskAreas.push(rel);
        todoFragments.push(`${rel}: ${c.text.slice(0, 120)}`);
      }
      if (c.type === 'architecture') {
        const archId = `decision:${rel}:arch`;
        nodes.push({
          id: archId,
          type: 'decision',
          label: `Architecture decision in ${rel}`,
          description: c.text,
          metadata: { source: rel },
        });
        edges.push(buildEdge(archId, rel, 'aligns_with', 0.7));
      }
    }

    // Register module nodes for parent directories
    const dir = path.dirname(rel);
    if (dir !== '.' && !seenModules.has(dir)) {
      seenModules.add(dir);
      nodes.push(buildModuleNode(dir));
    }
  }

  // ── 3. Compute risk areas from import counts ───────────────────────────────
  const HIGH_IMPORT_THRESHOLD = 5;
  for (const [file, count] of importCounts) {
    if (count >= HIGH_IMPORT_THRESHOLD && fileSet.has(file)) {
      if (!riskAreas.includes(file)) riskAreas.push(file);
    }
  }

  // Deduplicate
  const uniqueDeprecated = [...new Set(deprecationIds)];
  const uniqueRiskAreas = [...new Set(riskAreas)];

  // ── 4. Test coverage edges ─────────────────────────────────────────────────
  const testDir = path.join(root, 'tests');
  if (fs.existsSync(testDir) && fs.statSync(testDir).isDirectory()) {
    const testFiles = walkFiles(testDir, 3);
    for (const tRel of testFiles) {
      const tAbs = path.join(testDir, tRel);
      const testRelPath = `tests/${tRel}`;
      if (!fileSet.has(testRelPath)) {
        fileSet.add(testRelPath);
        nodes.push(buildFileNode(testRelPath));
      }
      let tContent: string;
      try { tContent = fs.readFileSync(tAbs, 'utf8'); }
      catch { continue; }
      const imports = parseImports(testRelPath, tContent);
      for (const imp of imports) {
        if (!imp.isExternal) {
          const resolved = resolveRelativeImport(root, `tests/${tRel}`, imp.name);
          if (resolved && fileSet.has(resolved)) {
            edges.push(buildEdge(testRelPath, resolved, 'tests', 0.8));
          }
        }
      }
    }
  }

  // ── 5. Read project-level files ────────────────────────────────────────────
  const vision = readVision(root);
  const readmeTodos = parseComments(readFile(root, 'README.md') ?? '').filter(c => c.type === 'todo');
  const planned: string[] = readmeTodos.map(c => c.text.slice(0, 120));

  const changelogContent = readFile(root, 'CHANGELOG.md');
  if (changelogContent) {
    const changelogNodeId = 'changelog:recent';
    const recentLines = changelogContent.split('\n').slice(0, 20).filter(l => l.trim());
    nodes.push({
      id: changelogNodeId,
      type: 'decision',
      label: 'Recent changelog decisions',
      description: recentLines.join('\n').slice(0, 500),
      metadata: { source: 'CHANGELOG.md' },
    });
    edges.push(buildEdge(changelogNodeId, 'constraint:changes', 'aligns_with', 0.5));
  }

  const archDoc = readFile(root, 'docs/ARCHITECTURE.md') ?? readFile(root, 'docs/architecture.md');
  const strictRules: string[] = [];
  if (archDoc) {
    const archNodeId = 'constraint:architecture-doc';
    nodes.push({
      id: archNodeId,
      type: 'constraint',
      label: 'Architecture document constraints',
      description: archDoc.slice(0, 500),
      metadata: { source: 'docs/ARCHITECTURE.md' },
    });
    const mustLines = parseMustConstraints(archDoc);
    strictRules.push(...mustLines);
  }

  const rubyConfig = readRubyConfig(root);
  const readOnly: string[] = rubyConfig.readOnly ?? [];
  if (rubyConfig.strictRules) strictRules.push(...rubyConfig.strictRules);

  const pkgJson = readPackageJson(root);
  if (pkgJson) {
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    for (const [name, version] of Object.entries(allDeps)) {
      const depId = `npm:${name}`;
      if (!extDepIds.has(depId)) {
        extDepIds.add(depId);
        const ver = typeof version === 'string' ? version : 'unknown';
        nodes.push({
          id: depId,
          type: 'concept',
          label: name,
          description: `External dependency: ${name}@${ver}`,
          metadata: { packageName: name, version: ver },
        });
      }
    }
  }

  // ── 6. Trajectory ──────────────────────────────────────────────────────────
  const trajectory = {
    vision,
    deprecated: uniqueDeprecated,
    inProgress: [] as string[],
    planned,
  };

  // ── 7. Test coverage classification ────────────────────────────────────────
  const testCoverage = classifyTestCoverage(nodes, edges);

  // ── 8. Read-only constraint node ───────────────────────────────────────────
  if (readOnly.length > 0) {
    const roNodeId = 'constraint:readonly';
    nodes.push({
      id: roNodeId,
      type: 'constraint',
      label: 'Read-only paths',
      description: `Paths that must never be modified by automated agents:\n${readOnly.map(p => `- ${p}`).join('\n')}`,
      metadata: { paths: readOnly },
    });
    for (const ro of readOnly) {
      nodes.push({
        id: `constraint:readonly:${ro}`,
        type: 'constraint',
        label: `Read-only: ${ro}`,
        description: `This path must not be modified by automated agents.`,
        metadata: { path: ro },
      });
      edges.push(buildEdge(`constraint:readonly:${ro}`, roNodeId, 'implements', 1.0));
    }
  }

  if (strictRules.length > 0) {
    const srNodeId = 'constraint:strict-rules';
    nodes.push({
      id: srNodeId,
      type: 'constraint',
      label: 'Strict rules',
      description: strictRules.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      metadata: { rules: strictRules },
    });
  }

  for (const ra of uniqueRiskAreas) {
    const raNode = nodes.find(n => n.id === ra);
    if (raNode) {
      edges.push(buildEdge(ra, 'constraint:risk-areas', 'violates', 0.4));
    }
  }
  if (uniqueRiskAreas.length > 0) {
    const raNodeId = 'constraint:risk-areas';
    const existing = nodes.find(n => n.id === raNodeId);
    if (!existing) {
      nodes.push({
        id: raNodeId,
        type: 'constraint',
        label: 'Risk areas',
        description: `Areas with known fragility, high change frequency, or tech debt:\n${todoFragments.map(f => `- ${f}`).join('\n')}`,
        metadata: { source: 'comment analysis + import graph' },
      });
    }
  }

  // ── 9. Build the final snapshot ────────────────────────────────────────────
  return {
    projectRoot: root,
    nodes,
    edges,
    trajectory,
    constraints: {
      readOnly,
      strictRules,
      riskAreas: uniqueRiskAreas,
      testCoverage,
    },
    extractedAt: Date.now(),
    version: '1.0.0',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File-system helpers
// ─────────────────────────────────────────────────────────────────────────────

function walkFiles(dir: string, maxDepth = 10): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (IGNORE_PATTERNS.some(p => {
        if (e.name === p) return true;
        if (p.startsWith('*') && e.name.endsWith(p.slice(1))) return true;
        return false;
      })) continue;
      if (e.name.startsWith('.')) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) {
        results.push(path.relative(dir, full));
      }
    }
  }
  walk(dir, 1);
  return results;
}

function readFile(root: string, relPath: string): string | null {
  const p = path.join(root, relPath);
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedImport {
  name: string;
  isExternal: boolean;
}

function parseImports(sourceFile: string, content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  // matches import/export X from 'Y' and require('Y') patterns
  const fromRe = /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+['"]([^'"]+)['"]/g;
  const importOnlyRe = /import\s+['"]([^'"]+)['"]/g;
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  const all = [...content.matchAll(fromRe), ...content.matchAll(importOnlyRe), ...content.matchAll(requireRe), ...content.matchAll(dynamicImportRe)];

  for (const m of all) {
    const specifier = m[1];
    if (!specifier) continue;
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      results.push({ name: specifier, isExternal: false });
    } else {
      results.push({ name: specifier, isExternal: true });
    }
  }
  return results;
}

function resolveRelativeImport(root: string, sourceFile: string, specifier: string): string | null {
  const sourceDir = path.dirname(path.join(root, sourceFile));
  const target = path.resolve(sourceDir, specifier);
  const ext = path.extname(target);
  const candidates = ext
    ? [target]
    : [target + '.ts', target + '.js', path.join(target, 'index.ts'), path.join(target, 'index.js')];
  for (const c of candidates) {
    const rel = path.relative(root, c);
    if (!rel.startsWith('..') && fs.existsSync(c)) return rel;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comment parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedComment {
  type: 'todo' | 'fixme' | 'deprecated' | 'architecture';
  text: string;
}

function parseComments(content: string): ParsedComment[] {
  const results: ParsedComment[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    const commentMatch = trimmed.match(/^\s*(?:\/\/|#)\s*(.*)/i) ?? trimmed.match(/^\s*\/\*\s*(.*?)\s*\*\/\s*$/i);
    if (!commentMatch) continue;
    const body = commentMatch[1];

    if (/^TODO[:\s]/i.test(body)) {
      results.push({ type: 'todo', text: body });
    } else if (/^FIXME[:\s]/i.test(body)) {
      results.push({ type: 'fixme', text: body });
    } else if (/^DEPRECATED[:\s]/i.test(body) || /^@deprecated\b/i.test(body)) {
      results.push({ type: 'deprecated', text: body });
    } else if (/@architecture\b/i.test(body)) {
      results.push({ type: 'architecture', text: body });
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project-level file readers
// ─────────────────────────────────────────────────────────────────────────────

function readVision(root: string): string {
  const readme = readFile(root, 'README.md');
  if (!readme) return 'No vision document found.';

  const lines = readme.split('\n');
  const firstPara: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (line.trim() === '' && firstPara.length > 0) break;
    if (line.trim()) firstPara.push(line.trim());
  }
  return firstPara.join(' ') || 'Project vision could not be extracted from README.';
}

function parseMustConstraints(content: string): string[] {
  const results: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim().replace(/^[-*]\s*/, '');
    if (/\bmust\b/i.test(trimmed) || /\bmust not\b/i.test(trimmed) || /\bshall\b/i.test(trimmed) || /\bshall not\b/i.test(trimmed)) {
      results.push(trimmed);
    }
  }
  return results;
}

interface RubyConfigData {
  readOnly?: string[];
  strictRules?: string[];
}

function readRubyConfig(root: string): RubyConfigData {
  const raw = readFile(root, '.aura.json');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return {
      readOnly: Array.isArray(parsed.readOnly) ? parsed.readOnly.filter((x: unknown): x is string => typeof x === 'string') : undefined,
      strictRules: Array.isArray(parsed.strictRules) ? parsed.strictRules.filter((x: unknown): x is string => typeof x === 'string') : undefined,
    };
  } catch {
    return {};
  }
}

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(root: string): PkgJson | null {
  const raw = readFile(root, 'package.json');
  if (!raw) return null;
  try { return JSON.parse(raw) as PkgJson; }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node / edge constructors
// ─────────────────────────────────────────────────────────────────────────────

function buildFileNode(relPath: string): ArchitectureNode {
  return {
    id: relPath,
    type: 'file',
    label: relPath,
    description: `Source file: ${relPath}`,
    metadata: { extension: path.extname(relPath) },
  };
}

function buildModuleNode(dirPath: string): ArchitectureNode {
  return {
    id: dirPath,
    type: 'module',
    label: dirPath + '/',
    description: `Module directory: ${dirPath}/`,
    metadata: { directory: true },
  };
}

function buildDepNode(pkgName: string): ArchitectureNode {
  return {
    id: `npm:${pkgName}`,
    type: 'concept',
    label: pkgName,
    description: `External npm package: ${pkgName}`,
    metadata: { packageName: pkgName },
  };
}

function buildEdge(from: string, to: string, relationship: ArchitectureEdge['relationship'], weight: number): ArchitectureEdge {
  return { from, to, relationship, weight, metadata: {} };
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────

function classifyTestCoverage(
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
): { module: string; coverage: 'high' | 'medium' | 'low' }[] {
  const moduleEdges = new Map<string, number>(); // module -> test edge count
  const moduleFiles = new Map<string, number>(); // module -> total file count

  for (const n of nodes) {
    if (n.type !== 'file') continue;
    const module = path.dirname(n.id);
    moduleFiles.set(module, (moduleFiles.get(module) ?? 0) + 1);
  }

  for (const e of edges) {
    if (e.relationship !== 'tests') continue;
    const module = path.dirname(e.to);
    moduleEdges.set(module, (moduleEdges.get(module) ?? 0) + 1);
  }

  const results: { module: string; coverage: 'high' | 'medium' | 'low' }[] = [];
  for (const [mod, fileCount] of moduleFiles) {
    if (mod === '.' || fileCount === 0) continue;
    const testCount = moduleEdges.get(mod) ?? 0;
    const ratio = testCount / fileCount;
    const coverage: 'high' | 'medium' | 'low' =
      ratio >= 0.5 ? 'high' : ratio >= 0.2 ? 'medium' : 'low';
    results.push({ module: mod, coverage });
  }
  return results;
}

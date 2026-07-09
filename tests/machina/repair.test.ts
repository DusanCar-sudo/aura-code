import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rewriteSpecAnchors, repairAnchors } from '../../src/machina/repair.js';
import { AAM_CLAIMS } from '../../src/machina/spec.js';

const SPEC_SNIPPET = `export const AAM_CLAIMS: VerifiableClaim[] = [
  {
    id: 'main-loop',
    component: 'delta',
    description: 'The main transition loop.',
    file: 'src/agent/loop.ts',
    line: 172,
    mustContain: 'while (true)',
  },
  {
    id: 'oracle-call',
    component: 'O',
    description: 'The oracle invocation.',
    file: 'src/agent/loop.ts',
    line: 235,
    mustContain: 'provider.stream(',
  },
];
`;

describe('rewriteSpecAnchors', () => {
  it('rewrites only the targeted claim, leaving the others byte-identical', () => {
    const out = rewriteSpecAnchors(SPEC_SNIPPET, [{ id: 'main-loop', from: 172, to: 173 }]);
    expect(out).toContain("id: 'main-loop'");
    expect(out).toContain('line: 173');
    expect(out).not.toContain('line: 172');
    expect(out).toContain('line: 235'); // oracle-call untouched
  });

  it('rewrites multiple anchors in one pass', () => {
    const out = rewriteSpecAnchors(SPEC_SNIPPET, [
      { id: 'main-loop', from: 172, to: 175 },
      { id: 'oracle-call', from: 235, to: 240 },
    ]);
    expect(out).toContain('line: 175');
    expect(out).toContain('line: 240');
  });

  it('skips an update whose recorded line no longer matches the source', () => {
    const out = rewriteSpecAnchors(SPEC_SNIPPET, [{ id: 'main-loop', from: 999, to: 173 }]);
    expect(out).toBe(SPEC_SNIPPET);
  });

  it('skips an update for an unknown claim id', () => {
    const out = rewriteSpecAnchors(SPEC_SNIPPET, [{ id: 'no-such-claim', from: 172, to: 173 }]);
    expect(out).toBe(SPEC_SNIPPET);
  });
});

describe('repairAnchors against a fixture tree', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-machina-repair-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeFixtureFile(relPath: string, content: string): void {
    const full = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('rewrites stale anchors in spec.ts and reports genuinely-missing claims', () => {
    // Build every claimed file with the content shifted one line down, so
    // every claim verifies as drifted with foundLine = line + 1.
    const files = new Set(AAM_CLAIMS.map(c => c.file));
    for (const file of files) {
      const claims = AAM_CLAIMS.filter(c => c.file === file);
      const totalLines = Math.max(...claims.map(c => c.line)) + 1;
      const lines = Array.from({ length: totalLines }, (_, i) => `// filler ${i + 1}`);
      for (const c of claims) lines[c.line] = c.mustContain; // index c.line = line c.line+1
      writeFixtureFile(file, lines.join('\n'));
    }
    // A minimal spec.ts for the repair to rewrite.
    const specSource = AAM_CLAIMS.map(c => `  {\n    id: '${c.id}',\n    line: ${c.line},\n  },`).join('\n');
    writeFixtureFile('src/machina/spec.ts', specSource);

    const result = repairAnchors(repoRoot);
    expect(result.failing).toEqual([]);
    expect(result.updated).toHaveLength(AAM_CLAIMS.length);

    const rewritten = fs.readFileSync(path.join(repoRoot, 'src', 'machina', 'spec.ts'), 'utf8');
    for (const c of AAM_CLAIMS) {
      const block = rewritten.slice(rewritten.indexOf(`id: '${c.id}'`));
      expect(Number(block.match(/line: (\d+)/)![1])).toBe(c.line + 1);
    }
  });

  it('does not touch spec.ts when nothing drifted', () => {
    const files = new Set(AAM_CLAIMS.map(c => c.file));
    for (const file of files) {
      const claims = AAM_CLAIMS.filter(c => c.file === file);
      const totalLines = Math.max(...claims.map(c => c.line));
      const lines = Array.from({ length: totalLines }, (_, i) => `// filler ${i + 1}`);
      for (const c of claims) lines[c.line - 1] = c.mustContain;
      writeFixtureFile(file, lines.join('\n'));
    }
    const specSource = '// pristine spec';
    writeFixtureFile('src/machina/spec.ts', specSource);

    const result = repairAnchors(repoRoot);
    expect(result.updated).toEqual([]);
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'machina', 'spec.ts'), 'utf8')).toBe(specSource);
  });
});

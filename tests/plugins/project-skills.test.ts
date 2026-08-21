import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadProjectSkills,
  formatSkillCatalog,
} from '../../src/plugins/project-skills.js';

/**
 * The gap this closes: .agents/skills was checked by doctor and read by nothing,
 * so "58 skills installed" and "0 skills reachable" were the same observable
 * state. These assert the two properties that keep them distinct — that the
 * directory is actually parsed, and that only names and descriptions reach the
 * prompt. The second one is not a style preference: the catalog in this repo is
 * 324 KB of bodies against 14 KB of descriptions, so a change that starts
 * inlining bodies does not degrade the prompt, it destroys it.
 */

let root: string;

function writeSkill(dir: string, name: string, frontmatter: string, body = 'Do the thing.') {
  const d = path.join(root, dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  return path.join(d, 'SKILL.md');
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-skills-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('loadProjectSkills', () => {
  it('returns nothing when no skills directory exists', () => {
    expect(loadProjectSkills(root)).toEqual([]);
  });

  it('reads .agents/skills and reports name, description and path', () => {
    const p = writeSkill('.agents/skills', 'tdd', 'name: tdd\ndescription: Test-driven development.');
    expect(loadProjectSkills(root)).toEqual([
      { name: 'tdd', description: 'Test-driven development.', path: p },
    ]);
  });

  it('reads .claude/skills too, for installers that write there', () => {
    writeSkill('.claude/skills', 'triage', 'description: Move issues through triage.');
    expect(loadProjectSkills(root).map(s => s.name)).toEqual(['triage']);
  });

  it('counts a skill once when .claude/skills symlinks .agents/skills', () => {
    // This is the layout `npx skills add` produces, so double-listing here
    // would double the prompt cost of every catalog in the wild.
    writeSkill('.agents/skills', 'tdd', 'description: Test-driven development.');
    fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(root, '.agents/skills/tdd'), path.join(root, '.claude/skills/tdd'));
    expect(loadProjectSkills(root).map(s => s.name)).toEqual(['tdd']);
  });

  it('falls back to the directory name when frontmatter has no name', () => {
    writeSkill('.agents/skills', 'grill-me', 'description: A relentless interview.');
    expect(loadProjectSkills(root)[0]!.name).toBe('grill-me');
  });

  it('drops a skill with no description — it would be unroutable', () => {
    // The model would have to read the body to learn whether the body is worth
    // reading, so listing it spends prompt budget on a coin flip.
    writeSkill('.agents/skills', 'mystery', 'name: mystery');
    expect(loadProjectSkills(root)).toEqual([]);
  });

  it('reads a block-scalar description', () => {
    // `description: |` over indented lines used to parse as the literal "|",
    // which silently removed the skill from the catalog while it still looked
    // installed to doctor and to `skills add`.
    const d = path.join(root, '.agents/skills/website-to-video');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'),
      '---\nname: website-to-video\ndescription: |\n  Capture a website.\n  Use when a user provides a URL.\n---\n\nBody.\n');
    const [skill] = loadProjectSkills(root);
    expect(skill!.description).toBe('Capture a website. Use when a user provides a URL.');
  });

  it('truncates a long description at a sentence boundary', () => {
    const long = 'First clause here. ' + 'padding words '.repeat(40);
    writeSkill('.agents/skills', 'verbose', `description: ${long}`);
    const d = loadProjectSkills(root)[0]!.description;
    expect(d.length).toBeLessThanOrEqual(201);
    expect(d.endsWith('…') || d.endsWith('.')).toBe(true);
  });

  it('skips a directory with no SKILL.md instead of failing the whole scan', () => {
    fs.mkdirSync(path.join(root, '.agents/skills/empty'), { recursive: true });
    writeSkill('.agents/skills', 'real', 'description: A real skill.');
    expect(loadProjectSkills(root).map(s => s.name)).toEqual(['real']);
  });

  it('sorts by name, so the prompt prefix is stable across runs', () => {
    // An unstable order would rewrite the cached system prefix on every start.
    writeSkill('.agents/skills', 'zeta', 'description: Z.');
    writeSkill('.agents/skills', 'alpha', 'description: A.');
    writeSkill('.agents/skills', 'mid', 'description: M.');
    expect(loadProjectSkills(root).map(s => s.name)).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('formatSkillCatalog', () => {
  it('renders nothing at all for an empty catalog', () => {
    // The caller concatenates this unconditionally, so a heading with nothing
    // under it would be worse than absent.
    expect(formatSkillCatalog([])).toBe('');
  });

  it('lists each skill with its description and path, and no body', () => {
    writeSkill('.agents/skills', 'tdd', 'description: Test-driven development.',
      'SECRET_BODY_MARKER — the full instructions.');
    const block = formatSkillCatalog(loadProjectSkills(root));
    expect(block).toContain('tdd — Test-driven development.');
    expect(block).toContain(path.join(root, '.agents/skills/tdd/SKILL.md'));
    expect(block).not.toContain('SECRET_BODY_MARKER');
  });

  it('tells the agent to read the SKILL.md before working, and not otherwise', () => {
    writeSkill('.agents/skills', 'tdd', 'description: Test-driven development.');
    const block = formatSkillCatalog(loadProjectSkills(root));
    expect(block).toMatch(/read_file its SKILL\.md BEFORE starting work/);
    expect(block).toMatch(/do not read a\s+skill just because it exists/);
  });
});

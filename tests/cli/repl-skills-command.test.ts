import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleSkillsCommand } from '../../src/cli/repl-skills-command.js';
import type { ProjectSkill } from '../../src/plugins/project-skills.js';

const skills: ProjectSkill[] = [
  { name: 'tdd', description: 'Test-driven development.', path: '/p/.agents/skills/tdd/SKILL.md' },
  { name: 'triage', description: 'Move issues through a state machine.', path: '/p/.agents/skills/triage/SKILL.md' },
  { name: 'gsap', description: 'GSAP animation reference.', path: '/p/.agents/skills/gsap/SKILL.md' },
];

const CTX = { projectRoot: '/p' };

describe(':skills', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const out = () => logSpy.mock.calls.map(c => String(c[0])).join('\n');

  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  it('lists every loaded skill with its description', () => {
    expect(handleSkillsCommand(':skills', CTX, () => skills)).toEqual({ handled: true });
    const printed = out();
    expect(printed).toContain('3 skill(s) available');
    for (const s of skills) expect(printed).toContain(s.name);
    expect(printed).toContain('Test-driven development.');
  });

  it('explains where to get skills when none are loaded', () => {
    expect(handleSkillsCommand(':skills', CTX, () => [])).toEqual({ handled: true });
    expect(out()).toContain('No skills loaded');
    expect(out()).toContain('npx skills@latest add');
  });

  it('filters on name', () => {
    handleSkillsCommand(':skills tri', CTX, () => skills);
    expect(out()).toContain('triage');
    expect(out()).not.toContain('gsap');
  });

  it('filters on description, not just name', () => {
    // The point of the filter is finding a skill you cannot name.
    handleSkillsCommand(':skills animation', CTX, () => skills);
    expect(out()).toContain('gsap');
    expect(out()).not.toContain('Test-driven');
  });

  it('says how many exist when the filter matches nothing', () => {
    handleSkillsCommand(':skills nonexistent', CTX, () => skills);
    expect(out()).toContain('No skill matches "nonexistent"');
    expect(out()).toContain('3 loaded');
  });

  it('states the routing rule, so the list does not read as commands to run', () => {
    handleSkillsCommand(':skills', CTX, () => skills);
    expect(out()).toMatch(/reads a\s+skill's SKILL\.md only when a task matches it/);
  });

  it('returns null for anything else, so the caller keeps matching', () => {
    expect(handleSkillsCommand(':skillset', CTX, () => skills)).toBeNull();
    expect(handleSkillsCommand(':help', CTX, () => skills)).toBeNull();
    expect(handleSkillsCommand('add a skills page', CTX, () => skills)).toBeNull();
  });
});

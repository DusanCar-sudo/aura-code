/**
 * The REPL's `:skills` command — shows the skill catalog the agent is actually
 * routing against.
 *
 * This exists because the catalog is otherwise invisible. Skills are injected
 * into the system prompt as names and descriptions (see project-skills.ts), so
 * from the outside an installed-but-unloaded skill and a loaded one look
 * identical: `npx skills add` prints a success line either way, and `aura
 * doctor` only counts directories that contain a SKILL.md. It does not parse
 * them, so a skill whose frontmatter carries no usable description passes
 * doctor and still never reaches the model. `:skills` reports the parsed
 * result — if a skill is missing from this list, the agent cannot see it.
 *
 * `:skills <query>` filters by substring against name and description, which
 * is how you check whether a specific skill would be findable at all.
 *
 * In its own module for the same reason repl-session-commands.ts is: cli/
 * index.ts self-executes on import, so a branch that lives there cannot be
 * covered by a test.
 */

import chalk from 'chalk';
import { FAINT_HEX, TEXT_DIM_HEX, TEXT_HEX } from './diamond.js';
import { loadProjectSkills, type ProjectSkill } from '../plugins/project-skills.js';
import type { ReplCommandResult } from './repl-session-commands.js';

/** The slice of ReplCtx this command touches. Declared structurally rather
 *  than importing ReplCtx so this module never depends on index.ts. */
export interface SkillsCommandCtx {
  projectRoot: string;
}

/** Injected in tests; production reads the real directories. */
export type SkillLoader = (projectRoot: string) => ProjectSkill[];

/**
 * Returns a result when `input` is :skills, or null to let the caller's
 * remaining branches try it.
 */
export function handleSkillsCommand(
  input: string,
  c: SkillsCommandCtx,
  load: SkillLoader = loadProjectSkills,
): ReplCommandResult | null {
  if (input !== ':skills' && !input.startsWith(':skills ')) return null;

  const query = input.startsWith(':skills ') ? input.slice(':skills '.length).trim().toLowerCase() : '';
  const all = load(c.projectRoot);

  if (all.length === 0) {
    console.log(chalk.hex(TEXT_DIM_HEX)(
      '\n  No skills loaded.\n' +
      '  Install some with:  npx skills@latest add <owner>/<repo>\n' +
      '  Aura reads .agents/skills/<name>/SKILL.md and .claude/skills/<name>/SKILL.md.\n',
    ));
    return { handled: true };
  }

  const shown = query
    ? all.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
    : all;

  if (shown.length === 0) {
    console.log(chalk.hex(TEXT_DIM_HEX)(`\n  No skill matches "${query}" (${all.length} loaded — :skills to list them all).\n`));
    return { handled: true };
  }

  const heading = query
    ? `  ${shown.length} of ${all.length} skill(s) matching "${query}":`
    : `  ${all.length} skill(s) available to the agent:`;
  console.log(chalk.hex(TEXT_DIM_HEX)('\n' + heading + '\n'));

  const width = Math.max(...shown.map(s => s.name.length));
  for (const s of shown) {
    console.log(
      chalk.hex(TEXT_HEX)('  ' + s.name.padEnd(width)) +
      chalk.hex(TEXT_DIM_HEX)('  ' + s.description),
    );
  }

  // The routing rule, not a usage hint: these are offered to the model as a
  // catalog, and it reads the body only when a task matches one.
  console.log(chalk.hex(FAINT_HEX)(
    '\n  Names and descriptions are in the system prompt; the agent reads a\n' +
    '  skill\'s SKILL.md only when a task matches it.\n',
  ));
  return { handled: true };
}

/**
 * Project-local skills — `.agents/skills/<name>/SKILL.md` in the working repo.
 *
 * This is where `npx skills add <repo>` installs, and it is a different source
 * from the plugin skills in loader.ts (`~/.aura/plugins/<name>/skills/`). Until
 * now nothing read it: doctor/checks.ts validates the directory and reports how
 * many skills it holds, but no loader ever opened one, so a repo could pass
 * `aura doctor` with fifty skills the agent could not see.
 *
 * The important difference from loadPluginSkillsBlock is what gets into the
 * prompt. That one concatenates every skill *body* and gates the whole blob on
 * a web-keyword regex, which works only because two plugin skills is ~2 KB. A
 * `skills add` catalog is a different order of magnitude — the one in this repo
 * is 58 skills and 324 KB of bodies, roughly 80k tokens, so "paste everything
 * when the task looks relevant" degenerates into "paste nothing, ever".
 *
 * So this loads names and descriptions only — 13 KB for the same 58 skills —
 * and the prompt tells the agent to read_file the SKILL.md when one matches.
 * That is also what makes it "when needed": routing is a decision the model
 * makes against the catalog, not a regex we maintain by hand.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter.js';

/** One catalog entry. Deliberately no body — see the module comment. */
export interface ProjectSkill {
  /** Directory name, or frontmatter `name:` when it sets one. */
  name: string;
  /** One-line summary the model routes on. Never empty (see loadProjectSkills). */
  description: string;
  /** Absolute path to SKILL.md, for the agent to read on demand. */
  path: string;
}

/**
 * Where skills live, in priority order. Both are scanned rather than the first
 * that exists: `skills add` writes the real files to .agents/skills and leaves
 * .claude/skills as symlinks to them, but other installers do the reverse, and
 * a repo can legitimately have hand-written skills in only one. Duplicates are
 * collapsed by resolved path, so the symlink layout yields each skill once.
 */
const SKILL_DIRS = ['.agents/skills', '.claude/skills'];

/** Longest description kept. Past this the entry is costing prompt budget
 *  without telling the model anything the first clause did not. */
const MAX_DESCRIPTION = 200;

/**
 * Read the skill catalog for a project. Never throws — a missing directory, an
 * unreadable file, or malformed frontmatter yields fewer entries, never an
 * error: skills are an enhancement, and a broken one must not stop a task.
 */
export function loadProjectSkills(projectRoot: string): ProjectSkill[] {
  const byRealPath = new Map<string, ProjectSkill>();

  for (const rel of SKILL_DIRS) {
    const dir = path.join(projectRoot, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;   // directory absent — the common case
    }

    for (const entry of entries) {
      // withFileTypes reports a symlinked directory as a symlink, and the
      // .claude/skills layout is entirely symlinks, so both are accepted.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      let key: string;
      let raw: string;
      try {
        key = fs.realpathSync(skillFile);
        if (byRealPath.has(key)) continue;
        raw = fs.readFileSync(skillFile, 'utf8');
      } catch {
        continue;   // no SKILL.md behind this entry
      }

      let description: string;
      let name: string;
      try {
        const { data } = parseFrontmatter(raw);
        description = cleanDescription(data.description);
        name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : entry.name;
      } catch {
        continue;   // malformed frontmatter
      }

      // A skill with no description is unroutable: the model would have to
      // read the body to find out whether the body is worth reading. Listing
      // it would spend prompt budget to offer a coin flip.
      if (!description) continue;

      byRealPath.set(key, { name, description, path: skillFile });
    }
  }

  return [...byRealPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render the catalog as a prompt block, or '' when there are no skills — the
 * caller concatenates it unconditionally, so an empty catalog must add nothing
 * rather than a heading with nothing under it.
 */
export function formatSkillCatalog(skills: ProjectSkill[]): string {
  if (skills.length === 0) return '';
  const rows = skills.map(s => `- ${s.name} — ${s.description}\n  ${s.path}`).join('\n');
  return `\n\n## Available skills
These are instruction sets installed in this project. Each line is a name, what
it covers, and the file holding the instructions. The bodies are NOT included
here — they total far more than this prompt can hold.

When a task matches one of these, read_file its SKILL.md BEFORE starting work,
and follow it. When none matches, ignore this section entirely; do not read a
skill just because it exists, and never mention skills you did not use.

${rows}`;
}

/** First sentence of a description, collapsed to one line and capped. Returns
 *  '' for anything that is not a usable string. */
function cleanDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Frontmatter descriptions are routinely wrapped across lines, and some are
  // block scalars whose value is the literal "|" (a nested structure the
  // parser skips) — those collapse to empty and get dropped by the caller.
  const flat = value.replace(/\s+/g, ' ').trim().replace(/^\|$/, '');
  if (!flat) return '';
  if (flat.length <= MAX_DESCRIPTION) return flat;

  // Prefer cutting at a sentence end inside the budget; a mid-clause cut reads
  // as a truncated fact rather than a short summary.
  const window = flat.slice(0, MAX_DESCRIPTION);
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (stop > MAX_DESCRIPTION / 2) return window.slice(0, stop + 1);
  return window.trimEnd() + '…';
}

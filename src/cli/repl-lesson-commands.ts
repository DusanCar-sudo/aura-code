/**
 * REPL commands for what Aura has learned: :lessons and :forget.
 *
 * The gap loop (agent/learning.ts) writes lessons into a file that is injected
 * into every subsequent system prompt. That is the point of it — but it also
 * means Aura is editing her own instructions, and until these commands existed
 * there was no way to read what she had written, and no way to take back a
 * lesson learned from a bad source or true only on the day it was recorded.
 *
 * An unreadable, uncorrectable store that feeds the prompt is a slow way to
 * accumulate confident wrongness. So: list it, and be able to delete from it.
 */

import chalk from 'chalk';
import * as path from 'path';
import {
  loadLessons, forgetLesson, globalLessonsPath, projectLessonsPath,
  type Lesson, type LessonScope,
} from '../agent/learning.js';
import type { Display } from './display.js';
import type { ReplCommandResult } from './repl-session-commands.js';

export interface LessonCommandCtx {
  display: Pick<Display, 'success' | 'warning'>;
  write: (text: string) => void;
  projectRoot?: string;
}

const DIM = '#8a94a6';
const FAINT = '#4a5568';
const ACCENT = '#cc785c';

function render(lessons: Lesson[], scope: LessonScope, where: string): string[] {
  if (lessons.length === 0) {
    return [chalk.hex(FAINT)(`  ${scope}: nothing learned yet  (${where})`)];
  }
  const out = [
    chalk.hex(ACCENT)(`  ${scope} — ${lessons.length} lesson(s)`) + chalk.hex(FAINT)(`  ${where}`),
  ];
  for (const l of lessons) {
    out.push(
      chalk.hex(DIM)(`    ${l.learnedAt}  `) + l.text,
      chalk.hex(FAINT)(`              :forget ${l.key}`),
    );
  }
  return out;
}

export function handleLessonCommand(
  input: string,
  c: LessonCommandCtx,
): ReplCommandResult | null {
  const norm = input.trim().replace(/\s+/g, ' ');
  const lower = norm.toLowerCase();

  // ── :lessons [global|project|<search>] ────────────────────────────────────
  if (lower === ':lessons' || lower === '/lessons'
      || lower.startsWith(':lessons ') || lower.startsWith('/lessons ')) {
    const arg = lower.includes(' ') ? norm.slice(norm.indexOf(' ') + 1).trim() : '';
    const wantScope: LessonScope | null =
      arg.toLowerCase() === 'global' ? 'global'
      : arg.toLowerCase() === 'project' ? 'project'
      : null;
    // Anything that isn't a scope word is treated as a search term.
    const term = wantScope ? '' : arg.toLowerCase();

    const lines: string[] = [''];
    for (const scope of ['global', 'project'] as const) {
      if (wantScope && wantScope !== scope) continue;
      if (scope === 'project' && !c.projectRoot) continue;

      const where = scope === 'global'
        ? globalLessonsPath()
        : projectLessonsPath(c.projectRoot!);
      let items = loadLessons(scope, c.projectRoot);
      if (term) items = items.filter(l => l.text.toLowerCase().includes(term));
      lines.push(...render(items, scope, path.basename(path.dirname(where)) + '/' + path.basename(where)));
      lines.push('');
    }
    if (term) lines.push(chalk.hex(FAINT)(`  filtered by "${term}"`), '');
    lines.push(chalk.hex(FAINT)('  :forget <key> removes one. Lessons are injected into every system prompt.'), '');
    for (const l of lines) c.write(l);
    return { handled: true };
  }

  // ── :forget <key> ─────────────────────────────────────────────────────────
  if (lower === ':forget' || lower === '/forget') {
    c.display.warning('Usage: :forget <key> — the key is shown under each entry in :lessons.');
    return { handled: true };
  }
  if (lower.startsWith(':forget ') || lower.startsWith('/forget ')) {
    const key = norm.slice(norm.indexOf(' ') + 1).trim();
    if (!key) {
      c.display.warning('Usage: :forget <key> — see :lessons for keys.');
      return { handled: true };
    }
    // Both scopes are tried: the user reads a key off a listing and should not
    // have to also tell us which file it came from.
    const dropped: LessonScope[] = [];
    if (forgetLesson(key, 'global')) dropped.push('global');
    if (c.projectRoot && forgetLesson(key, 'project', c.projectRoot)) dropped.push('project');

    if (dropped.length === 0) {
      c.display.warning(`No lesson with key "${key}". Run :lessons to see what is stored.`);
    } else {
      c.display.success(`Forgot "${key}" (${dropped.join(' and ')}). It will not be in the next prompt.`);
    }
    return { handled: true };
  }

  return null;
}

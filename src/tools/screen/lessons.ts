/**
 * A dedicated memory for what computer use has learned by doing.
 *
 * Separate from the general memory in agent/unified-memory.ts on purpose.
 * Ordinary lessons are about a codebase; these are about a *machine* — where a
 * particular app puts its buttons, which capture path returns a black frame on
 * this compositor, that a click at a screen edge lands on the other monitor.
 * They are worth keeping precisely because they are expensive to rediscover:
 * on this machine, working out that three of the four obvious input paths
 * accept commands and silently do nothing cost an afternoon.
 *
 * Two design consequences follow from "expensive to rediscover":
 *
 *   1. Scoped to the machine, not the project. A note about where Chrome's
 *      address bar sits is true across every repo and false on another display
 *      layout, so it lives beside the other host-level memory in ~/.aura and is
 *      keyed by the screen geometry it was learned at.
 *   2. First occurrences only. A log of every click is noise that buries the
 *      one line worth reading. Recording is therefore deduplicated on a caller
 *      supplied key, and a repeat is a no-op rather than an append.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { auraHome } from '../../util/aura-home.js';

export interface Lesson {
  /** Stable identity for the thing learned; a repeat of the same key is
   *  ignored. e.g. "chrome:address-bar" or "capture:black-frame". */
  key: string;
  /** One line, in the words the next run needs to read. */
  text: string;
  /** Screen geometry it was learned at — a coordinate note is worthless, and
   *  actively misleading, under a different layout. */
  geometry?: string;
  learnedAt: string;
}

/** How many lessons are kept. Past this the oldest go: the file is a prompt
 *  block, and an unbounded one silently eats the context it is meant to save. */
export const MAX_LESSONS = 60;

export function lessonsPath(): string {
  const home = auraHome();
  return path.join(home, 'memory', 'computer-use-lessons.json');
}

export function loadLessons(): Lesson[] {
  try {
    const raw = JSON.parse(fs.readFileSync(lessonsPath(), 'utf8'));
    return Array.isArray(raw) ? (raw as Lesson[]).filter(l => l && l.key && l.text) : [];
  } catch {
    return [];
  }
}

/**
 * Record a lesson the first time it happens. Returns true when something was
 * written, false when this key was already known — callers can use that to
 * decide whether it is worth telling the user.
 *
 * Never throws: an unwritable home must not fail the action the agent was
 * actually performing. Losing a note is cheaper than losing the task.
 */
export function recordLesson(key: string, text: string, geometry?: string): boolean {
  const existing = loadLessons();
  if (existing.some(l => l.key === key)) return false;

  const next = [...existing, { key, text, geometry, learnedAt: new Date().toISOString() }];
  // Drop from the front: the oldest lesson is the one most likely to describe
  // a layout or an app version that has since changed.
  const trimmed = next.slice(Math.max(0, next.length - MAX_LESSONS));
  try {
    const p = lessonsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(trimmed, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Forget one lesson (it turned out wrong, or the layout changed). */
export function forgetLesson(key: string): boolean {
  const kept = loadLessons().filter(l => l.key !== key);
  try {
    fs.writeFileSync(lessonsPath(), JSON.stringify(kept, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the lessons as a prompt block, or '' when there are none — the caller
 * concatenates unconditionally, so an empty store must add nothing rather than
 * a heading with nothing under it.
 *
 * `geometry` is the current screen geometry: lessons learned at a different one
 * are still shown but marked, because a stale coordinate that looks current is
 * worse than one the model knows to distrust.
 */
export function formatLessonsBlock(geometry?: string): string {
  const lessons = loadLessons();
  if (lessons.length === 0) return '';
  const lines = lessons.map(l => {
    const stale = l.geometry && geometry && l.geometry !== geometry
      ? ` (learned at ${l.geometry} — this screen is ${geometry}, so re-check before trusting coordinates)`
      : '';
    return `- ${l.text}${stale}`;
  });
  return `\n\n## What this machine has taught you about controlling it
Learned from previous runs on this computer. Treat as hints, not as truth —
verify with a screenshot before acting on anything positional.

${lines.join('\n')}`;
}

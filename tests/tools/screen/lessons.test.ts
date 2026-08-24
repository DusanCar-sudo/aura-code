import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  recordLesson, loadLessons, forgetLesson, formatLessonsBlock, lessonsPath, MAX_LESSONS,
} from '../../../src/tools/screen/lessons.js';

/**
 * The value of this store is entirely in what it *refuses* to keep. A log of
 * every action is noise that buries the one line worth reading, and a stale
 * coordinate presented as current is worse than no coordinate at all — so the
 * dedup, the cap, and the geometry marking are the features. Storing and
 * reading back is the easy part.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lessons-'));
  vi.stubEnv('AURA_HOME', home);
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('recording', () => {
  it('records the first occurrence and reports that it did', () => {
    expect(recordLesson('chrome:address-bar', 'Chrome address bar sits at y≈591')).toBe(true);
    expect(loadLessons().map(l => l.text)).toEqual(['Chrome address bar sits at y≈591']);
  });

  it('ignores a repeat of the same key', () => {
    // "important stuff that happened for the FIRST time" — a second click on
    // the same button must not append a second line.
    recordLesson('chrome:address-bar', 'first wording');
    expect(recordLesson('chrome:address-bar', 'different wording, same fact')).toBe(false);
    expect(loadLessons()).toHaveLength(1);
    expect(loadLessons()[0].text).toBe('first wording');
  });

  it('keeps distinct keys apart', () => {
    recordLesson('a', 'one'); recordLesson('b', 'two');
    expect(loadLessons()).toHaveLength(2);
  });

  it('drops the oldest past the cap', () => {
    // The file is a prompt block; unbounded growth eats the context it exists
    // to save. Oldest goes first — most likely to describe a layout that has
    // since changed.
    for (let i = 0; i < MAX_LESSONS + 5; i++) recordLesson(`k${i}`, `lesson ${i}`);
    const kept = loadLessons();
    expect(kept).toHaveLength(MAX_LESSONS);
    expect(kept[0].text).toBe('lesson 5');
    expect(kept.at(-1)!.text).toBe(`lesson ${MAX_LESSONS + 4}`);
  });

  it('does not throw, or lose the run, when the store is unwritable', () => {
    const blocker = path.join(home, 'file');
    fs.writeFileSync(blocker, 'x');
    vi.stubEnv('AURA_HOME', path.join(blocker, 'aura'));
    expect(() => recordLesson('k', 'v')).not.toThrow();
    expect(recordLesson('k', 'v')).toBe(false);
  });

  it('survives a corrupt store rather than failing every later action', () => {
    fs.mkdirSync(path.dirname(lessonsPath()), { recursive: true });
    fs.writeFileSync(lessonsPath(), 'not json');
    expect(loadLessons()).toEqual([]);
    expect(recordLesson('k', 'v')).toBe(true);
  });
});

describe('forgetting', () => {
  it('removes a lesson that turned out to be wrong', () => {
    recordLesson('a', 'one'); recordLesson('b', 'two');
    forgetLesson('a');
    expect(loadLessons().map(l => l.key)).toEqual(['b']);
  });
});

describe('the prompt block', () => {
  it('is empty when nothing has been learned', () => {
    expect(formatLessonsBlock('2259x2471')).toBe('');
  });

  it('lists what was learned and says to verify it', () => {
    recordLesson('a', 'The taskbar is on the laptop screen, not the external one');
    const block = formatLessonsBlock('2259x2471');
    expect(block).toContain('The taskbar is on the laptop screen');
    expect(block).toMatch(/hints, not as truth/);
  });

  it('marks a lesson learned at a different screen geometry', () => {
    // A coordinate note from a single-monitor session is actively misleading
    // once a second display shifts the origin.
    recordLesson('a', 'OK button at (1150,1894)', '2259x2471');
    const block = formatLessonsBlock('1920x1080');
    expect(block).toContain('learned at 2259x2471');
    expect(block).toContain('re-check before trusting coordinates');
  });

  it('does not mark it when the geometry still matches', () => {
    recordLesson('a', 'OK button at (1150,1894)', '2259x2471');
    expect(formatLessonsBlock('2259x2471')).not.toContain('re-check');
  });
});

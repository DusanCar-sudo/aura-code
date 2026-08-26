import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleLessonCommand, type LessonCommandCtx } from '../../src/cli/repl-lesson-commands.js';
import { recordLesson, loadLessons, lessonKey } from '../../src/agent/learning.js';

let home: string;
let proj: string;
let written: string[];
let said: string[];
let ctx: LessonCommandCtx;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lc-home-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lc-proj-'));
  vi.stubEnv('AURA_HOME', home);
  written = []; said = [];
  ctx = {
    display: { success: (m: string) => said.push(m), warning: (m: string) => said.push(m) },
    write: (t: string) => written.push(t),
    projectRoot: proj,
  };
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const out = () => written.join('\n');

describe(':lessons', () => {
  it('shows both scopes with the key needed to remove each one', () => {
    recordLesson('a global fact about providers', 'global');
    recordLesson('a local fact about src/ layout', 'project', proj);

    expect(handleLessonCommand(':lessons', ctx)).toMatchObject({ handled: true });

    expect(out()).toMatch(/global fact about providers/);
    expect(out()).toMatch(/local fact about src/);
    expect(out()).toMatch(/:forget a-global-fact-about-providers/);
  });

  it('says plainly when nothing has been learned', () => {
    handleLessonCommand(':lessons', ctx);
    expect(out()).toMatch(/nothing learned yet/);
  });

  it('filters to one scope', () => {
    recordLesson('a global fact', 'global');
    recordLesson('a project fact', 'project', proj);

    handleLessonCommand(':lessons global', ctx);

    expect(out()).toMatch(/a global fact/);
    expect(out()).not.toMatch(/a project fact/);
  });

  it('treats a non-scope argument as a search term', () => {
    recordLesson('something about pipewire capture', 'global');
    recordLesson('something about model prefixes', 'global');

    handleLessonCommand(':lessons pipewire', ctx);

    expect(out()).toMatch(/pipewire capture/);
    expect(out()).not.toMatch(/model prefixes/);
    expect(out()).toMatch(/filtered by "pipewire"/);
  });

  it('says the lessons reach the prompt, so the listing is not mistaken for a log', () => {
    handleLessonCommand(':lessons', ctx);
    expect(out()).toMatch(/injected into every system prompt/);
  });

  it('skips the project scope when there is no project', () => {
    recordLesson('a global fact', 'global');
    handleLessonCommand(':lessons', { ...ctx, projectRoot: undefined });
    expect(out()).toMatch(/a global fact/);
    expect(out()).not.toMatch(/project:/);
  });
});

describe(':forget', () => {
  it('removes a lesson so it will not be in the next prompt', () => {
    recordLesson('a wrong thing Aura believes', 'global');
    const key = lessonKey('a wrong thing Aura believes');

    const r = handleLessonCommand(`:forget ${key}`, ctx);

    expect(r).toMatchObject({ handled: true });
    expect(loadLessons('global')).toHaveLength(0);
    expect(said.join(' ')).toMatch(/Forgot/);
  });

  it('finds the key without being told which scope it came from', () => {
    recordLesson('a project-scoped belief', 'project', proj);
    const key = lessonKey('a project-scoped belief');

    handleLessonCommand(`:forget ${key}`, ctx);

    expect(loadLessons('project', proj)).toHaveLength(0);
    expect(said.join(' ')).toMatch(/project/);
  });

  it('leaves the other lessons alone', () => {
    recordLesson('keep this one', 'global');
    recordLesson('drop this one', 'global');

    handleLessonCommand(`:forget ${lessonKey('drop this one')}`, ctx);

    expect(loadLessons('global').map(l => l.text)).toEqual(['keep this one']);
  });

  it('says so when the key matches nothing, rather than silently succeeding', () => {
    handleLessonCommand(':forget no-such-key', ctx);
    expect(said.join(' ')).toMatch(/No lesson with key/);
  });

  it('explains itself when given no key', () => {
    handleLessonCommand(':forget', ctx);
    expect(said.join(' ')).toMatch(/Usage: :forget <key>/);
  });
});

describe('dispatch', () => {
  it('passes on anything it does not own', () => {
    expect(handleLessonCommand(':forgetful thoughts', ctx)).toBeNull();
    expect(handleLessonCommand('what lessons have you learned', ctx)).toBeNull();
    expect(handleLessonCommand(':compact', ctx)).toBeNull();
  });

  it('accepts the slash spellings', () => {
    expect(handleLessonCommand('/lessons', ctx)).toMatchObject({ handled: true });
    expect(handleLessonCommand('/forget x', ctx)).toMatchObject({ handled: true });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  asTaskPrompt, buildRecording, deleteRecording, listRecordings,
  loadRecording, recordingsDir, saveRecording,
} from '../../src/record/store.js';
import type { RawEvent } from '../../src/record/types.js';

let home: string;
const prev = process.env.AURA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rec-'));
  process.env.AURA_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AURA_HOME; else process.env.AURA_HOME = prev;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

let clock = 0;
const tap = (code: string): RawEvent[] => [
  { t: (clock += 10), kind: 'key', code, value: 1 },
  { t: (clock += 5), kind: 'key', code, value: 0 },
];

describe('where recordings live', () => {
  it('is the state directory, never the project', () => {
    // A recording is about the operator's desktop and may contain anything
    // they typed while it ran. One appearing in `git status` — or in a commit
    // — is a mistake they cannot take back.
    expect(recordingsDir().startsWith(home)).toBe(true);
  });

  it('writes owner-only', () => {
    clock = 0;
    const file = saveRecording(buildRecording(tap('KEY_A')));
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});

describe('building one', () => {
  it('compiles steps and collects what was typed', () => {
    clock = 0;
    const rec = buildRecording([...tap('KEY_H'), ...tap('KEY_I')]);
    expect(rec.steps).toHaveLength(1);
    expect(rec.typedText).toEqual(['hi']);
  });

  it('names itself after the first real thing that happened', () => {
    clock = 0;
    const rec = buildRecording([
      { t: 10, kind: 'button', code: 'BTN_LEFT', value: 1 },
      { t: 20, kind: 'button', code: 'BTN_LEFT', value: 0 },
    ]);
    // A poor name but a true one, and better than nine "Recording"s.
    expect(rec.title).toBe('left click');
  });

  it('keeps a title the operator gave it', () => {
    clock = 0;
    const rec = buildRecording(tap('KEY_A'), { title: 'copy the invoice column' });
    expect(rec.title).toBe('copy the invoice column');
  });

  it('handles a recording where nothing happened', () => {
    const rec = buildRecording([]);
    expect(rec.steps).toEqual([]);
    expect(rec.durationMs).toBe(0);
    expect(rec.title).toBe('empty recording');
  });
});

describe('round trip', () => {
  it('saves, loads and lists', () => {
    clock = 0;
    const rec = buildRecording(tap('KEY_A'), { title: 'first' });
    saveRecording(rec);
    expect(loadRecording(rec.id)?.title).toBe('first');
    expect(listRecordings().map((r) => r.id)).toContain(rec.id);
    expect(deleteRecording(rec.id)).toBe(true);
    expect(loadRecording(rec.id)).toBeNull();
  });

  it('skips a damaged file instead of failing the listing', () => {
    clock = 0;
    saveRecording(buildRecording(tap('KEY_A'), { title: 'good' }));
    fs.writeFileSync(path.join(recordingsDir(), 'broken.json'), '{ nope');
    expect(listRecordings().map((r) => r.title)).toEqual(['good']);
  });

  it('returns nothing before anything is recorded', () => {
    expect(listRecordings()).toEqual([]);
  });
});

describe('handing it to an agent', () => {
  it('describes steps, and tells it to look rather than reuse positions', () => {
    // The point of the whole design: row 2 of a list is not where row 1 was,
    // so a coordinate replay is wrong by the second repetition — silently.
    clock = 0;
    const rec = buildRecording([
      { t: 10, kind: 'button', code: 'BTN_LEFT', value: 1 },
      { t: 20, kind: 'button', code: 'BTN_LEFT', value: 0 },
      { t: 30, kind: 'key', code: 'KEY_LEFTCTRL', value: 1 },
      ...tap('KEY_C'),
      { t: 90, kind: 'key', code: 'KEY_LEFTCTRL', value: 0 },
    ], { shots: ['shot-1.png'] });

    const prompt = asTaskPrompt(rec, 20);
    expect(prompt).toContain('20 times');
    expect(prompt).toMatch(/looking at the screen/);
    expect(prompt).toContain('left click');
    expect(prompt).toContain('Ctrl+C');
    expect(prompt).toContain('shot-1.png');
  });

  it('says so when there are no screenshots to go on', () => {
    clock = 0;
    expect(asTaskPrompt(buildRecording(tap('KEY_A')))).toMatch(/No screenshots/);
  });

  it('drops waits — a pause is not an instruction', () => {
    const rec = buildRecording([
      { t: 0, kind: 'key', code: 'KEY_A', value: 1 },
      { t: 5, kind: 'key', code: 'KEY_A', value: 0 },
      { t: 9000, kind: 'key', code: 'KEY_B', value: 1 },
      { t: 9005, kind: 'key', code: 'KEY_B', value: 0 },
    ]);
    expect(rec.steps.some((s) => s.kind === 'wait')).toBe(true);
    expect(asTaskPrompt(rec)).not.toMatch(/^\d+\. Wait/m);
  });
});

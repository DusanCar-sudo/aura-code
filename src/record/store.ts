/**
 * Where caught demonstrations are kept.
 *
 * Under the state directory, never in the project: a recording is about the
 * operator's desktop, not about the repository they happened to be in, and it
 * may contain anything they typed while it ran. A file like that appearing in
 * someone's `git status` — or worse, in a commit — is a mistake they cannot
 * take back.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { auraPath } from '../util/aura-home.js';
import { compile, typedRuns } from './compile.js';
import type { RawEvent, Recording, Step } from './types.js';

export function recordingsDir(): string {
  return auraPath('recordings');
}

export function recordingPath(id: string): string {
  return path.join(recordingsDir(), `${id}.json`);
}

/** Where a recording's click screenshots go. Beside the recording itself. */
export function shotsDir(id: string): string {
  return path.join(recordingsDir(), `${id}-shots`);
}

export function newRecordingId(): string {
  return crypto.randomBytes(5).toString('hex');
}

/**
 * Build a Recording from raw events.
 *
 * The title is the first thing the demonstration actually did, when the
 * operator did not name it — "click (left)" is a poor name but a true one, and
 * better than a list of untitled recordings called Recording 1..9.
 */
export function buildRecording(
  events: RawEvent[],
  opts: { title?: string; shots?: string[]; id?: string } = {},
): Recording {
  const steps = compile(events, { shots: opts.shots })
    .map(st => (st.kind === 'type' ? { ...st, text: redactSecrets(st.text) } : st));
  const durationMs = events.length ? events[events.length - 1].t : 0;
  return {
    id: opts.id ?? newRecordingId(),
    title: opts.title?.trim() || firstMeaningfulStep(steps) || 'empty recording',
    createdAt: new Date().toISOString(),
    durationMs,
    steps,
    shots: opts.shots ?? [],
    typedText: typedRuns(steps).map(redactSecrets),
  };
}

function firstMeaningfulStep(steps: Step[]): string | null {
  for (const step of steps) {
    if (step.kind === 'wait') continue;
    if (step.kind === 'type') return `type "${step.text.slice(0, 30)}"`;
    if (step.kind === 'press') return step.label;
    if (step.kind === 'click') return `${step.button} click`;
    if (step.kind === 'scroll') return `scroll ${step.direction}`;
  }
  return null;
}

/**
 * Typed text that looks like a credential, masked. A demonstration is
 * recorded across every window, so a password or key typed during it would
 * otherwise sit in the recording, be printed back, and be replayed to the
 * model as part of the task.
 */
export function redactSecrets(text: string): string {
  return text
    // provider/API key shapes: sk-…, ghp_…, xoxb-…, AKIA…, long hex/base64 runs
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted key]')
    .replace(/\b(ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, '[redacted token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]')
    // 32+ key-alphabet chars mixing letters and digits, no '/': keys, not paths
    .replace(/(?<![A-Za-z0-9+_/-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_/-])/g, '[redacted secret]');
}

/** The recordings directory, private to this user (screenshots show the screen). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is ignored for a directory that already exists
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

export function saveRecording(rec: Recording): string {
  const file = recordingPath(rec.id);
  ensurePrivateDir(path.dirname(file));
  // 0600, and it matters more here than for most files Aura writes: a
  // recording can contain whatever was typed while it ran.
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** One recording, or null. Never throws on a damaged file. */
export function loadRecording(id: string): Recording | null {
  try {
    const rec = JSON.parse(fs.readFileSync(recordingPath(id), 'utf8')) as Recording;
    return Array.isArray(rec?.steps) ? rec : null;
  } catch {
    return null;
  }
}

/** Every recording, newest first. */
export function listRecordings(): Recording[] {
  try {
    return fs.readdirSync(recordingsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadRecording(path.basename(f, '.json')))
      .filter((r): r is Recording => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function deleteRecording(id: string): boolean {
  try {
    fs.rmSync(recordingPath(id), { force: true });
    // The screenshots go with it. They are pictures of the operator's desktop
    // at the moment of a click, so leaving them behind after a delete would
    // keep exactly the thing they asked to be rid of.
    fs.rmSync(shotsDir(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The recording as a task an agent can carry out.
 *
 * Written as a numbered procedure rather than coordinates, because that is the
 * only form that survives the second repetition: row 2 of a list is not where
 * row 1 was. The agent is told to look at the screen and find the equivalent
 * control, which is what makes "do this for all 20 rows" possible at all.
 */
export function asTaskPrompt(rec: Recording, repeat = 1): string {
  const lines = rec.steps
    .filter((s) => s.kind !== 'wait')
    .map((s, i) => `${i + 1}. ${describeForAgent(s)}`);

  const header = repeat > 1
    ? `Repeat the following procedure ${repeat} times, advancing to the next item each time.`
    : 'Carry out the following procedure.';

  return [
    header,
    '',
    'It was demonstrated once and recorded. The step list is what was done, not',
    'where it was done: find each target by looking at the screen, because the',
    'position that worked for the first item will not be right for the next one.',
    '',
    ...lines,
    '',
    rec.shots.length
      ? `Screenshots taken at each click are available and show the pointer: ${rec.shots.join(', ')}`
      : 'No screenshots were captured, so infer each target from the surrounding steps.',
  ].join('\n');
}

function describeForAgent(step: Step): string {
  switch (step.kind) {
    case 'type': return `Type: ${JSON.stringify(step.text)}`;
    case 'press': return `Press ${step.label}`;
    case 'click': return step.count > 1
      ? `${step.count}× ${step.button} click${step.shot ? ` — target shown in ${step.shot}` : ''}`
      : `${step.button} click${step.shot ? ` — target shown in ${step.shot}` : ''}`;
    case 'scroll': return `Scroll ${step.direction} about ${step.notches} notches`;
    case 'wait': return `Wait ${(step.ms / 1000).toFixed(1)}s`;
  }
}

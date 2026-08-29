/**
 * `:catchthis` — demonstrate a job once, get it back as a repeatable task.
 *
 * Do the thing yourself while it records; stop; read back what it saw; then
 * hand it to the agent, optionally "and now do that for all 20 rows".
 *
 * In its own module for the reason every repl-*-command is: cli/index.ts
 * self-executes on import, so a branch that lives there cannot be covered by a
 * test — which is how a command ends up advertised and unimplemented at once.
 *
 * The disclosure is not decoration. This reads the keyboard at the kernel
 * level, which means it sees every window, not just Aura's — including the one
 * you alt-tab to in the middle. So recording announces itself, the operator is
 * shown everything that was typed before it is stored, and the recording is
 * written 0600 into the state directory rather than anywhere near a project.
 */

import type { RawEvent, Recording } from '../record/types.js';
import type { RecorderHandle } from '../record/recorder.js';
import { describe as describeStep } from '../record/compile.js';
import {
  asTaskPrompt, buildRecording, deleteRecording, listRecordings, loadRecording,
  newRecordingId, saveRecording, shotsDir,
} from '../record/store.js';
import type { ShotTaker } from '../record/shots.js';

export interface CatchCommandCtx {
  print: (line: string) => void;
  /** The recording in progress, if any. Held by the REPL across commands. */
  session: {
    handle: RecorderHandle | null; startedAt: number; title?: string;
    /** The id is minted at start, so click screenshots can be written into the
     *  recording's own directory while it is still being recorded. */
    id?: string;
    shots?: ShotTaker;
  };
  /** Injected so tests do not spawn a real recorder. */
  start?: (opts: { onClick?: (i: number) => Promise<string | null> }) => RecorderHandle;
  /** Builds the screenshot taker for a recording. Absent means capture nothing. */
  shotsFor?: (dir: string) => ShotTaker;
  /** Hand a prompt to the agent as a task. */
  run?: (prompt: string) => void;
}

export interface CatchCommandResult { handled: true }

const TRIGGERS = [':catchthis', '/catchthis', ':catch', '/catch'];

/**
 * Split ":catchthis run 20" into its verb and argument.
 *
 * `all` is the whole argument, kept because a title is not a verb: parsing
 * ":catchthis copy the invoice column" as verb="copy" and using the remainder
 * dropped the first word of every name that began with one.
 */
function parse(input: string): { verb: string; rest: string; all: string } | null {
  const trimmed = input.trim();
  const matched = TRIGGERS.find(
    (t) => trimmed.toLowerCase() === t || trimmed.toLowerCase().startsWith(`${t} `),
  );
  if (!matched) return null;
  const all = trimmed.slice(matched.length).trim();
  const [verb, ...tail] = all.split(/\s+/);
  return { verb: (verb ?? '').toLowerCase(), rest: tail.join(' '), all };
}

export async function handleCatchCommand(
  input: string,
  c: CatchCommandCtx,
): Promise<CatchCommandResult | null> {
  const parsed = parse(input);
  if (!parsed) return null;
  const { verb, rest, all } = parsed;

  if (verb === 'list' || verb === 'ls') { showList(c); return { handled: true }; }
  if (verb === 'show') { showOne(c, rest); return { handled: true }; }
  if (verb === 'forget' || verb === 'rm') { forget(c, rest); return { handled: true }; }
  if (verb === 'run' || verb === 'do') { await runOne(c, rest); return { handled: true }; }

  // No verb: a toggle. Recording is a mode you are either in or not, and
  // making people remember a second command to stop is how recordings get
  // left running.
  if (c.session.handle) await stop(c, all);
  else await begin(c, all);
  return { handled: true };
}

async function begin(c: CatchCommandCtx, title: string): Promise<void> {
  const id = newRecordingId();
  const shots = c.shotsFor?.(shotsDir(id));
  const handle = (c.start ?? (() => { throw new Error('no recorder'); }))({
    onClick: shots ? (i) => shots.take(i) : undefined,
  });
  try {
    const { devices } = await handle.ready;
    c.session.id = id;
    c.session.shots = shots;
    c.session.handle = handle;
    c.session.startedAt = Date.now();
    // Kept on the session, because the name is given when you START — you know
    // what you are about to demonstrate — and `stop` is typed bare. Reading it
    // from the stop command's argument threw the name away every time.
    c.session.title = title;
    c.print('');
    c.print(`  ● Recording ${devices} input device${devices === 1 ? '' : 's'}.`);
    // Said every time, not once: what is being captured changes with whatever
    // window happens to be focused, so "you accepted this weeks ago" is not
    // consent for what it will see now.
    c.print('    This reads the keyboard directly, so it captures every window —');
    c.print('    including anything you type outside Aura. Avoid passwords.');
    c.print('    Do the job now, then type :catchthis again to stop.');
    if (shots) c.print('    A screenshot is taken at each click, to show what was clicked.');
    if (title) c.print(`    It will be saved as "${title}".`);
    c.print('');
  } catch (e) {
    c.print(`  Could not start recording: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function stop(c: CatchCommandCtx, title: string): Promise<void> {
  const handle = c.session.handle;
  if (!handle) return;
  c.session.handle = null;

  const events: RawEvent[] = await handle.stop();
  const shots = handle.shots();
  await c.session.shots?.close();
  // A name given at stop wins, so an afterthought still lands.
  const rec = buildRecording(events, {
    id: c.session.id,
    title: title || c.session.title,
    shots,
  });
  c.session.title = undefined;
  c.session.id = undefined;
  c.session.shots = undefined;

  if (rec.steps.length === 0) {
    c.print('  Nothing was recorded — no keys, clicks or scrolling. Not saved.');
    return;
  }

  saveRecording(rec);
  c.print('');
  const shotNote = rec.shots.length ? `, ${rec.shots.length} screenshot${rec.shots.length === 1 ? '' : 's'}` : '';
  c.print(`  ■ Caught "${rec.title}" — ${rec.steps.length} steps, ${(rec.durationMs / 1000).toFixed(1)}s${shotNote}  [${rec.id}]`);
  printSteps(c, rec);

  if (rec.typedText.length) {
    // Shown deliberately and separately. Burying captured keystrokes inside a
    // step list nobody reads would not be a disclosure.
    c.print('');
    c.print('  Text captured while recording — check nothing private is here:');
    for (const text of rec.typedText) c.print(`    ${JSON.stringify(text)}`);
    c.print(`    Remove it with :catchthis forget ${rec.id}`);
  }
  c.print('');
  c.print(`  Replay it with :catchthis run ${rec.id}, or :catchthis run ${rec.id} 20 to repeat.`);
  c.print('');
}

function printSteps(c: CatchCommandCtx, rec: Recording): void {
  rec.steps.forEach((step, i) => {
    c.print(`    ${String(i + 1).padStart(2)}. ${describeStep(step)}`);
  });
}

function showList(c: CatchCommandCtx): void {
  const all = listRecordings();
  if (!all.length) {
    c.print('  Nothing caught yet. Type :catchthis, do the job, then :catchthis again.');
    return;
  }
  c.print('');
  for (const rec of all) {
    const when = rec.createdAt.slice(0, 16).replace('T', ' ');
    c.print(`  ${rec.id}  ${when}  ${rec.steps.length} steps  ${rec.title}`);
  }
  c.print('');
}

function showOne(c: CatchCommandCtx, id: string): void {
  const rec = id ? loadRecording(id) : listRecordings()[0];
  if (!rec) { c.print(`  No recording "${id}".`); return; }
  c.print('');
  c.print(`  ${rec.title}  [${rec.id}]`);
  printSteps(c, rec);
  c.print('');
}

async function runOne(c: CatchCommandCtx, rest: string): Promise<void> {
  const [id, times] = rest.split(/\s+/);
  const rec = id ? loadRecording(id) : listRecordings()[0];
  if (!rec) { c.print(`  No recording "${id}". Try :catchthis list.`); return; }

  const repeat = Math.max(1, Number.parseInt(times ?? '1', 10) || 1);
  if (!c.run) {
    c.print('  Replay needs computer use, which is off. Turn it on with :compon.');
    return;
  }
  c.print(`  Handing "${rec.title}" to the agent${repeat > 1 ? `, ${repeat} times` : ''}…`);
  c.run(asTaskPrompt(rec, repeat));
}

function forget(c: CatchCommandCtx, id: string): void {
  if (!id) { c.print('  Which one? :catchthis forget <id>'); return; }
  c.print(deleteRecording(id) ? `  Forgot ${id}.` : `  No recording "${id}".`);
}

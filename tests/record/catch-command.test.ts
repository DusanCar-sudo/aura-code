import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleCatchCommand, type CatchCommandCtx } from '../../src/cli/repl-catch-command.js';
import type { RawEvent } from '../../src/record/types.js';
import type { RecorderHandle } from '../../src/record/recorder.js';

/**
 * :catchthis records the keyboard at the kernel level, so it sees every window
 * — not just Aura's. Most of what is pinned here is therefore about the
 * operator knowing that, and being shown what was captured before it is kept.
 */

let home: string;
const prev = process.env.AURA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-catch-'));
  process.env.AURA_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AURA_HOME; else process.env.AURA_HOME = prev;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const fakeRecorder = (events: RawEvent[], shots: string[] = []): RecorderHandle => ({
  ready: Promise.resolve({ devices: 3 }),
  events: () => events,
  stop: async () => events,
  shots: () => shots,
});

const ctx = (events: RawEvent[] = [], shots: string[] = []) => {
  const printed: string[] = [];
  const ran: string[] = [];
  const clicks: number[] = [];
  const c: CatchCommandCtx = {
    print: (l) => printed.push(l),
    session: { handle: null, startedAt: 0 },
    start: () => fakeRecorder(events, shots),
    run: (p) => ran.push(p),
  };
  return { c, printed, ran, clicks, out: () => printed.join('\n') };
};

const typed = (word: string): RawEvent[] => {
  let t = 0;
  return [...word].flatMap((ch) => [
    { t: (t += 10), kind: 'key' as const, code: `KEY_${ch.toUpperCase()}`, value: 1 },
    { t: (t += 5), kind: 'key' as const, code: `KEY_${ch.toUpperCase()}`, value: 0 },
  ]);
};

describe('what it answers to', () => {
  it('takes :catchthis and its short form', async () => {
    for (const trigger of [':catchthis', ':catch', '/catchthis']) {
      const t = ctx();
      expect(await handleCatchCommand(trigger, t.c), trigger).not.toBeNull();
    }
  });

  it('leaves other input alone', async () => {
    const t = ctx();
    expect(await handleCatchCommand('what does catchthis do?', t.c)).toBeNull();
    expect(await handleCatchCommand(':catchup', t.c)).toBeNull();
  });
});

describe('recording', () => {
  it('warns that it captures every window, every time it starts', async () => {
    // Not once at install: what gets captured depends on whichever window is
    // focused, so an old acceptance is not consent for what it sees now.
    const t = ctx();
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).toMatch(/every window/i);
    expect(t.out()).toMatch(/passwords/i);
  });

  it('toggles — the same command stops it', async () => {
    const t = ctx(typed('hi'));
    await handleCatchCommand(':catchthis', t.c);
    expect(t.c.session.handle).not.toBeNull();
    await handleCatchCommand(':catchthis', t.c);
    expect(t.c.session.handle).toBeNull();
    expect(t.out()).toMatch(/Caught/);
  });

  it('shows the captured keystrokes separately, so they are actually read', async () => {
    const t = ctx(typed('secret'));
    await handleCatchCommand(':catchthis', t.c);
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).toMatch(/Text captured while recording/);
    expect(t.out()).toContain('"secret"');
    expect(t.out()).toMatch(/:catchthis forget/);
  });

  it('saves nothing when nothing happened', async () => {
    const t = ctx([]);
    await handleCatchCommand(':catchthis', t.c);
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).toMatch(/Nothing was recorded/);
    expect(await countSaved()).toBe(0);
  });

  it('keeps the name the operator gave it', async () => {
    const t = ctx(typed('hi'));
    await handleCatchCommand(':catchthis copy the invoice column', t.c);
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).toContain('copy the invoice column');
  });
});

describe('working with what was caught', () => {
  const record = async (word = 'hi', title = 'a job') => {
    const t = ctx(typed(word));
    await handleCatchCommand(`:catchthis ${title}`, t.c);
    await handleCatchCommand(':catchthis', t.c);
    return t;
  };

  it('lists them', async () => {
    await record();
    const t = ctx();
    await handleCatchCommand(':catchthis list', t.c);
    expect(t.out()).toContain('a job');
  });

  it('says so when there is nothing to list', async () => {
    const t = ctx();
    await handleCatchCommand(':catchthis list', t.c);
    expect(t.out()).toMatch(/Nothing caught yet/);
  });

  it('hands a repeat count to the agent', async () => {
    const first = await record();
    const id = /\[([0-9a-f]+)\]/.exec(first.out())?.[1] ?? '';
    const t = ctx();
    await handleCatchCommand(`:catchthis run ${id} 20`, t.c);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]).toContain('20 times');
    // The instruction that makes the second repetition possible at all.
    expect(t.ran[0]).toMatch(/looking at the screen/);
  });

  it('refuses to replay when computer use is off, and says how to turn it on', async () => {
    await record();
    const t = ctx();
    t.c.run = undefined;
    await handleCatchCommand(':catchthis run', t.c);
    expect(t.out()).toMatch(/:compon/);
  });

  it('forgets one on request', async () => {
    const first = await record();
    const id = /\[([0-9a-f]+)\]/.exec(first.out())?.[1] ?? '';
    const t = ctx();
    await handleCatchCommand(`:catchthis forget ${id}`, t.c);
    expect(t.out()).toMatch(/Forgot/);
    expect(await countSaved()).toBe(0);
  });
});

async function countSaved(): Promise<number> {
  try {
    return fs.readdirSync(path.join(home, 'recordings')).filter((f) => f.endsWith('.json')).length;
  } catch { return 0; }
}

describe('screenshots at each click', () => {
  const clickEvents: RawEvent[] = [
    { t: 10, kind: 'button', code: 'BTN_LEFT', value: 1 },
    { t: 20, kind: 'button', code: 'BTN_LEFT', value: 0 },
  ];

  it('captures nothing when no taker is supplied', async () => {
    // Computer use off: the step list is still worth having, so a recording
    // without shots must remain a normal outcome rather than a failure.
    const t = ctx(clickEvents);
    await handleCatchCommand(':catchthis', t.c);
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).not.toMatch(/screenshot/i);
  });

  it('tells the operator the screen is being captured too', async () => {
    // Recording the keyboard is disclosed on every start; photographing the
    // screen is at least as intrusive and gets the same treatment.
    const t = ctx(clickEvents, ['shot-00.png']);
    t.c.shotsFor = () => ({ take: async () => 'shot-00.png', close: async () => {} });
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).toMatch(/screenshot is taken at each click/i);
  });

  it('counts the shots it kept and passes them to the agent', async () => {
    const t = ctx(clickEvents, ['shot-00.png']);
    t.c.shotsFor = () => ({ take: async () => 'shot-00.png', close: async () => {} });
    await handleCatchCommand(':catchthis a job', t.c);
    await handleCatchCommand(':catchthis', t.c);
    expect(t.out()).toMatch(/1 screenshot/);

    const id = /\[([0-9a-f]+)\]/.exec(t.out())?.[1] ?? '';
    const r = ctx();
    await handleCatchCommand(`:catchthis run ${id}`, r.c);
    expect(r.ran[0]).toContain('shot-00.png');
  });

  it('closes the capture session when recording stops', async () => {
    // The sidecar holds a portal stream; leaving it open would keep the screen
    // being captured after the operator believes recording ended.
    let closed = false;
    const t = ctx(clickEvents, []);
    t.c.shotsFor = () => ({ take: async () => null, close: async () => { closed = true; } });
    await handleCatchCommand(':catchthis', t.c);
    await handleCatchCommand(':catchthis', t.c);
    expect(closed).toBe(true);
  });
});

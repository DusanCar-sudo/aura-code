import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleComputerCommand, type ComputerCommandCtx } from '../../src/cli/repl-computer-commands.js';
import { setComputerUseEnabled, isComputerUseEnabled } from '../../src/tools/computer.js';
import { checkComputerUseGate, isAcknowledged, acknowledge, COMPUTER_USE_ENV } from '../../src/tools/screen/disclosure.js';

/**
 * The property under test is the one the two-key gate was protecting: computer
 * use must never end up on without a deliberate human act. :compon is allowed
 * to be that act — a declined disclosure, or anything the model could emit,
 * must not be.
 */

let home: string;
let written: string[];
let answered: boolean;
let ctx: ComputerCommandCtx;
const said: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-comp-'));
  vi.stubEnv('AURA_HOME', home);
  vi.stubEnv(COMPUTER_USE_ENV, '');
  delete process.env[COMPUTER_USE_ENV];
  setComputerUseEnabled(false);
  written = [];
  said.length = 0;
  answered = true;
  ctx = {
    display: { success: (m: string) => said.push(m), warning: (m: string) => said.push(m) },
    confirm: async () => answered,
    write: (t: string) => written.push(t),
  };
});
afterEach(() => {
  setComputerUseEnabled(false);
  delete process.env[COMPUTER_USE_ENV];
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe(':compon', () => {
  it('shows the disclosure and, on yes, satisfies the gate in-session', async () => {
    expect(checkComputerUseGate(isComputerUseEnabled()).allowed).toBe(false);

    const r = await handleComputerCommand(':compon', ctx);

    expect(r).toMatchObject({ handled: true, newComputerUse: true });
    expect(written.join('\n')).toMatch(/whole screen/);
    expect(isAcknowledged()).toBe(true);
    // Both halves, together — a half-configured state is what this rescues.
    expect(isComputerUseEnabled()).toBe(true);
    expect(process.env[COMPUTER_USE_ENV]).toBe('1');
    expect(checkComputerUseGate(isComputerUseEnabled()).allowed).toBe(true);
  });

  it('leaves everything off when the disclosure is declined', async () => {
    answered = false;

    const r = await handleComputerCommand(':compon', ctx);

    expect(r).toMatchObject({ handled: true, newComputerUse: false });
    expect(isAcknowledged()).toBe(false);
    expect(isComputerUseEnabled()).toBe(false);
    expect(process.env[COMPUTER_USE_ENV]).toBeUndefined();
    expect(checkComputerUseGate(isComputerUseEnabled()).allowed).toBe(false);
  });

  it('warns that a portal dialog is coming, since a missed one looks like a hang', async () => {
    if (process.platform !== 'linux') return;
    acknowledge();

    await handleComputerCommand(':compon', ctx);

    expect(said.join(' ')).toMatch(/screen-sharing dialog/i);
    expect(said.join(' ')).toMatch(/behind other windows/i);
  });

  it('does not re-ask once the machine has acknowledged', async () => {
    acknowledge();

    await handleComputerCommand(':compon', ctx);

    // `written` is the disclosure channel; the portal warning goes to display.
    expect(written).toHaveLength(0);
    expect(isComputerUseEnabled()).toBe(true);
  });

  it('is idempotent — a second :compon reports rather than re-prompts', async () => {
    acknowledge();
    await handleComputerCommand(':compon', ctx);
    said.length = 0;

    await handleComputerCommand(':compon', ctx);

    expect(said.join(' ')).toMatch(/already on/i);
    expect(isComputerUseEnabled()).toBe(true);
  });
});

describe(':compoff', () => {
  it('drops both halves of the gate', async () => {
    acknowledge();
    await handleComputerCommand(':compon', ctx);
    expect(checkComputerUseGate(isComputerUseEnabled()).allowed).toBe(true);

    const r = await handleComputerCommand(':compoff', ctx);

    expect(r).toMatchObject({ handled: true, newComputerUse: false });
    expect(isComputerUseEnabled()).toBe(false);
    expect(process.env[COMPUTER_USE_ENV]).toBeUndefined();
    expect(checkComputerUseGate(isComputerUseEnabled()).allowed).toBe(false);
  });

  it('is safe with nothing running', async () => {
    const r = await handleComputerCommand(':compoff', ctx);
    expect(r).toMatchObject({ handled: true });
    expect(isComputerUseEnabled()).toBe(false);
  });

  it('does not revoke the machine acknowledgement — consent is not a session setting', async () => {
    acknowledge();
    await handleComputerCommand(':compon', ctx);
    await handleComputerCommand(':compoff', ctx);
    expect(isAcknowledged()).toBe(true);
  });
});

describe(':comp status', () => {
  it('reports off, and names both halves plus the acknowledgement', async () => {
    const r = await handleComputerCommand(':comp', ctx);
    expect(r).toMatchObject({ handled: true });
    const out = written.join('\n');
    expect(out).toMatch(/Computer use: OFF/);
    expect(out).toContain(COMPUTER_USE_ENV);
    expect(out).toMatch(/disclosure/);
  });

  it('reports on once enabled', async () => {
    acknowledge();
    await handleComputerCommand(':compon', ctx);
    written.length = 0;

    await handleComputerCommand(':comp', ctx);

    expect(written.join('\n')).toMatch(/Computer use: ON/);
  });

  it('changes nothing', async () => {
    await handleComputerCommand(':comp', ctx);
    expect(isComputerUseEnabled()).toBe(false);
    expect(process.env[COMPUTER_USE_ENV]).toBeUndefined();
  });
});

describe('dispatch', () => {
  it('accepts the spaced and slash spellings', async () => {
    acknowledge();
    for (const on of [':compon', '/compon', ':comp on', ':computer on']) {
      setComputerUseEnabled(false);
      delete process.env[COMPUTER_USE_ENV];
      expect(await handleComputerCommand(on, ctx)).toMatchObject({ newComputerUse: true });
    }
  });

  it('passes on anything it does not own, so :compact still reaches the compactor', async () => {
    expect(await handleComputerCommand(':compact', ctx)).toBeNull();
    expect(await handleComputerCommand(':compress', ctx)).toBeNull();
    expect(await handleComputerCommand('take a screenshot', ctx)).toBeNull();
    expect(isComputerUseEnabled()).toBe(false);
  });
});

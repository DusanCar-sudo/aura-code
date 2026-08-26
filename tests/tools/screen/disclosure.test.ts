import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  checkComputerUseGate, isAcknowledged, acknowledge, acknowledgementPath,
  COMPUTER_USE_DISCLOSURE, COMPUTER_USE_ENV,
} from '../../../src/tools/screen/disclosure.js';

/**
 * The property under test is not "the gate works" but "the gate cannot be
 * satisfied by accident". PermissionSystem defaults to 'auto', which approves
 * every tool that is not run_shell or mcp connect — so if this gate ever
 * consults the permission level, screen capture and input injection become
 * enabled-by-default for every user. These assertions are what stops that.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ack-'));
  vi.stubEnv('AURA_HOME', home);
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const ON = { [COMPUTER_USE_ENV]: '1' } as NodeJS.ProcessEnv;

describe('the computer-use gate', () => {
  it('refuses when neither the flag nor the env var is set', () => {
    const r = checkComputerUseGate(false, {} as NodeJS.ProcessEnv);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/--computer/);
  });

  it('refuses the env var alone — a stale shell profile must not enable this', () => {
    expect(checkComputerUseGate(false, ON).allowed).toBe(false);
  });

  it('refuses the flag alone — a flag copied from a forum post must not either', () => {
    expect(checkComputerUseGate(true, {} as NodeJS.ProcessEnv).allowed).toBe(false);
  });

  it('asks for the disclosure when both are set but it was never accepted', () => {
    const r = checkComputerUseGate(true, ON);
    expect(r.allowed).toBe(false);
    expect(r.needsDisclosure).toBe(true);
  });

  it('allows once both are set and the disclosure is accepted', () => {
    acknowledge();
    expect(checkComputerUseGate(true, ON)).toEqual({ allowed: true });
  });

  it('accepts only 1/true/yes, not any non-empty value', () => {
    acknowledge();
    for (const v of ['1', 'true', 'TRUE', 'yes']) {
      expect(checkComputerUseGate(true, { [COMPUTER_USE_ENV]: v } as NodeJS.ProcessEnv).allowed, v).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'maybe', '']) {
      expect(checkComputerUseGate(true, { [COMPUTER_USE_ENV]: v } as NodeJS.ProcessEnv).allowed, v).toBe(false);
    }
  });

  it('tells the model not to retry, so a refusal does not become a loop', () => {
    // Without this the model burns its turns re-calling a tool that cannot work.
    expect(checkComputerUseGate(false, {} as NodeJS.ProcessEnv).reason).toMatch(/do not retry/i);
  });
});

describe('acknowledgement', () => {
  it('starts unacknowledged and persists once accepted', () => {
    expect(isAcknowledged()).toBe(false);
    acknowledge();
    expect(isAcknowledged()).toBe(true);
    expect(fs.existsSync(acknowledgementPath())).toBe(true);
  });

  it('does not throw when the home directory cannot be created', () => {
    // AURA_HOME under a regular file: mkdir fails with ENOTDIR immediately.
    // (/proc paths were the obvious choice and hung the runner outright.)
    const blocker = path.join(home, 'a-file');
    fs.writeFileSync(blocker, 'x');
    vi.stubEnv('AURA_HOME', path.join(blocker, 'aura'));
    expect(() => acknowledge()).not.toThrow();
    // Unwritable means "ask again next time", never "assume they agreed".
    expect(isAcknowledged()).toBe(false);
  });

  it('treats a corrupt record as not accepted', () => {
    fs.mkdirSync(path.dirname(acknowledgementPath()), { recursive: true });
    fs.writeFileSync(acknowledgementPath(), 'not json');
    expect(isAcknowledged()).toBe(false);
  });

});

describe('the disclosure text', () => {
  it('names what actually leaks, in concrete terms', () => {
    // "may transmit screen data" is a sentence people skip. The specifics are
    // the point: this is what was actually in the first real capture.
    for (const s of ['whole screen', 'email', 'password manager', 'banking']) {
      expect(COMPUTER_USE_DISCLOSURE.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  it('says the input is real and unsandboxed', () => {
    expect(COMPUTER_USE_DISCLOSURE).toMatch(/no sandbox/i);
    expect(COMPUTER_USE_DISCLOSURE).toMatch(/real pointer|real keyboard/i);
  });

  it('says how to stop and how to turn it off', () => {
    expect(COMPUTER_USE_DISCLOSURE).toMatch(/:stop|Ctrl\+C/);
    expect(COMPUTER_USE_DISCLOSURE).toContain(COMPUTER_USE_ENV);
    // The in-session switch is the one the reader can act on immediately;
    // naming only the startup env var used to mean the fix was "restart".
    expect(COMPUTER_USE_DISCLOSURE).toContain(':compoff');
  });

  it('does not promise retention behaviour Aura cannot control', () => {
    expect(COMPUTER_USE_DISCLOSURE).toMatch(/retained/i);
    expect(COMPUTER_USE_DISCLOSURE).not.toMatch(/never stored|not retained|we do not keep/i);
  });
});

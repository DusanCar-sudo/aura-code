import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { rtkWrap, rtkAvailable, resetRtkProbe } from '../src/util/rtk.js';

/**
 * The regression these guard: routing tool output through RTK cut a session from
 * 1.28M input tokens to 253K, but the first version prefixed `rtk ` onto every
 * command unconditionally. On any machine without RTK installed — which is most
 * of them, for a published npm package — every run_shell and git tool call would
 * have come back "rtk: command not found".
 */

describe('rtkWrap', () => {
  let binDir: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rtk-path-'));
    vi.stubEnv('PATH', binDir);        // a PATH with nothing on it
    vi.stubEnv('AURA_RTK', '');
    resetRtkProbe();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRtkProbe();
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  /** Put an executable `rtk` on the stubbed PATH. */
  const installRtk = (): string => {
    const bin = path.join(binDir, process.platform === 'win32' ? 'rtk.CMD' : 'rtk');
    fs.writeFileSync(bin, '#!/bin/sh\nexec "$@"\n');
    fs.chmodSync(bin, 0o755);
    resetRtkProbe();
    return bin;
  };

  it('leaves the command alone when rtk is not installed', () => {
    expect(rtkAvailable()).toBe(false);
    expect(rtkWrap('git diff')).toBe('git diff');
    expect(rtkWrap('npm test')).toBe('npm test');
  });

  it('routes through rtk when it is on PATH', () => {
    installRtk();
    expect(rtkAvailable()).toBe(true);
    expect(rtkWrap('git diff')).toBe('rtk git diff');
  });

  it('never double-prefixes an already-wrapped command', () => {
    installRtk();
    expect(rtkWrap('rtk git status --short')).toBe('rtk git status --short');
    expect(rtkWrap('  rtk grep foo')).toBe('  rtk grep foo');
  });

  it('honours AURA_RTK as an override in both directions', () => {
    installRtk();
    vi.stubEnv('AURA_RTK', '0');
    expect(rtkWrap('git diff')).toBe('git diff');   // installed, forced off

    fs.rmSync(path.join(binDir, process.platform === 'win32' ? 'rtk.CMD' : 'rtk'));
    resetRtkProbe();
    vi.stubEnv('AURA_RTK', '1');
    expect(rtkWrap('git diff')).toBe('rtk git diff'); // absent, forced on
  });

  it('probes PATH once, not on every command', () => {
    const bin = installRtk();
    expect(rtkWrap('git diff')).toBe('rtk git diff');
    // A tool that shells out on every turn cannot re-scan PATH each time, so the
    // answer is cached for the life of the process.
    fs.rmSync(bin);
    expect(rtkWrap('git log')).toBe('rtk git log');
    resetRtkProbe();
    expect(rtkWrap('git log')).toBe('git log');
  });

  it('handles an empty command and an empty PATH without throwing', () => {
    expect(rtkWrap('')).toBe('');
    vi.stubEnv('PATH', '');
    resetRtkProbe();
    expect(rtkAvailable()).toBe(false);
  });
});

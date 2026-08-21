import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { rtkWrap, rtkAvailable, resetRtkProbe, firstToken } from '../src/util/rtk.js';

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

  /**
   * The second regression, found the hard way: `rtk` is a subcommand dispatcher,
   * not a transparent prefix. Wrapping a command it has no subcommand for makes
   * it exit 127 with "No such file or directory (os error 2)". An agent trying
   * to write a file with `cat > page.html <<EOF` hit this three times in a row
   * and was killed by the stall guard having produced nothing.
   */
  describe('only wraps commands rtk actually proxies', () => {
    beforeEach(() => { installRtk(); });

    it('wraps the tools rtk has a filter for', () => {
      for (const cmd of ['git diff', 'grep -r foo src', 'ls -la', 'find . -name "*.ts"',
                         'npm test', 'cargo build', 'docker ps', 'rg pattern']) {
        expect(rtkWrap(cmd)).toBe(`rtk ${cmd}`);
      }
    });

    it('leaves alone the commands that made rtk exit 127', () => {
      // Each of these was previously turned into `rtk <unknown-subcommand>`.
      expect(rtkWrap('cat file.txt')).toBe('cat file.txt');
      expect(rtkWrap('cd /tmp')).toBe('cd /tmp');
      expect(rtkWrap('echo hello')).toBe('echo hello');
      expect(rtkWrap('sed -i s/a/b/ f')).toBe('sed -i s/a/b/ f');
      expect(rtkWrap('python3 script.py')).toBe('python3 script.py');
      expect(rtkWrap('mkdir -p design/out')).toBe('mkdir -p design/out');
    });

    it('does not wrap a heredoc file write — the exact failure that broke :designx', () => {
      const heredoc = "cat > design/index.html <<'AURAEOF'\n<!doctype html>\nAURAEOF";
      expect(rtkWrap(heredoc)).toBe(heredoc);
    });

    it('does not wrap a variable-assignment prefix', () => {
      expect(rtkWrap('FOO=1 git diff')).toBe('FOO=1 git diff');
    });

    it('does not wrap shell compound syntax whose first word is not a proxied tool', () => {
      expect(rtkWrap('cd /tmp && ls')).toBe('cd /tmp && ls');
      expect(rtkWrap('(echo hi)')).toBe('(echo hi)');
      expect(rtkWrap('{ echo hi; }')).toBe('{ echo hi; }');
      expect(rtkWrap('if true; then ls; fi')).toBe('if true; then ls; fi');
      expect(rtkWrap('for i in 1 2; do ls; done')).toBe('for i in 1 2; do ls; done');
    });

    it('still wraps a proxied tool that leads a compound command', () => {
      // `rtk git diff && echo done` is valid shell and rtk handles its own half.
      expect(rtkWrap('git diff && echo done')).toBe('rtk git diff && echo done');
      expect(rtkWrap('grep foo f | head')).toBe('rtk grep foo f | head');
    });

    it('never wraps a whitespace-only command into a bare `rtk`', () => {
      // A bare `rtk` prints its help and exits 0 — a no-op that reports success.
      expect(rtkWrap('   ')).toBe('   ');
      expect(rtkWrap('\n')).toBe('\n');
      expect(rtkWrap('\n  git diff')).toBe('\n  rtk git diff');
    });

    it('preserves leading whitespace when it does wrap', () => {
      expect(rtkWrap('  git diff')).toBe('  rtk git diff');
    });
  });

  describe('firstToken', () => {
    it('reads the leading word past whitespace and newlines', () => {
      expect(firstToken('  \n git diff')).toBe('git');
      expect(firstToken('git')).toBe('git');
      expect(firstToken('')).toBe('');
      expect(firstToken('   ')).toBe('');
    });

    it('stops at shell metacharacters instead of swallowing them', () => {
      expect(firstToken('git;ls')).toBe('git');
      expect(firstToken('(echo')).toBe('');
      expect(firstToken('cat>f')).toBe('cat');
    });
  });

  it('handles an empty command and an empty PATH without throwing', () => {
    expect(rtkWrap('')).toBe('');
    vi.stubEnv('PATH', '');
    resetRtkProbe();
    expect(rtkAvailable()).toBe(false);
  });
});

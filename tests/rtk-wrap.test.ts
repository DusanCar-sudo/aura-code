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

  /**
   * `rtk` proxies one simple command and exec()s its argv with no shell, so
   * `rtk ` in front of a shell string is a category error. `rtk cd X && cmd`
   * parses as `rtk cd X` && `cmd`: rtk gets argv ["cd","X"], there is no
   * /usr/bin/cd, the exec dies with "[rtk: No such file or directory (os error
   * 2)]", && short-circuits, and `cmd` never runs — which stalled an agent loop
   * retrying a form that could never succeed. The `;` variant was worse: the cd
   * was swallowed the same way but `;` does not short-circuit, so the rest of
   * the line ran in the *original* directory and looked like it had worked.
   */
  describe('shell operators', () => {
    beforeEach(installRtk);

    it('leaves a builtin head alone and still wraps the tool after &&', () => {
      expect(rtkWrap('cd /tmp && git diff')).toBe('cd /tmp && rtk git diff');
    });

    it('leaves a builtin head alone in the ; form too', () => {
      // The bug's silent-failure mode: this used to run `pwd` in the wrong cwd.
      expect(rtkWrap('cd /tmp ; pwd')).toBe('cd /tmp ; pwd');
      expect(rtkWrap('cd /tmp ; git log')).toBe('cd /tmp ; rtk git log');
    });

    it('wraps both sides of && and ||', () => {
      expect(rtkWrap('git diff && git log')).toBe('rtk git diff && rtk git log');
      expect(rtkWrap('git diff || git status')).toBe('rtk git diff || rtk git status');
      expect(rtkWrap('npm run build && npm test')).toBe('rtk npm run build && rtk npm test');
    });

    it('wraps each stage of a pipeline', () => {
      expect(rtkWrap('git log | wc -l')).toBe('rtk git log | rtk wc -l');
      // A non-proxied stage is left bare; the proxied one is still filtered.
      expect(rtkWrap('git log | head -5')).toBe('rtk git log | head -5');
      expect(rtkWrap('cat f | grep foo | wc -l')).toBe('cat f | rtk grep foo | rtk wc -l');
    });

    it('leaves redirects at the outer shell', () => {
      expect(rtkWrap('git diff > out.txt')).toBe('rtk git diff > out.txt');
      expect(rtkWrap('git diff 2>&1 && git log')).toBe('rtk git diff 2>&1 && rtk git log');
      expect(rtkWrap('git log >> log.txt')).toBe('rtk git log >> log.txt');
    });

    it('does not break subshells, brace groups or keywords', () => {
      // `rtk (cd /tmp && pwd)` was a hard shell syntax error, not even ENOENT.
      expect(rtkWrap('(cd /tmp && pwd)')).toBe('(cd /tmp && pwd)');
      expect(rtkWrap('{ cd /tmp; pwd; }')).toBe('{ cd /tmp; pwd; }');
      expect(rtkWrap('for f in a b; do echo $f; done')).toBe('for f in a b; do echo $f; done');
      expect(rtkWrap('if true; then echo x; fi')).toBe('if true; then echo x; fi');
    });

    it('does not treat operators inside a command substitution as top level', () => {
      expect(rtkWrap('echo $(cd /tmp && pwd)')).toBe('echo $(cd /tmp && pwd)');
      expect(rtkWrap('git diff $(ls | head -1)')).toBe('rtk git diff $(ls | head -1)');
    });

    it('steps over an assignment prefix to reach the real head', () => {
      expect(rtkWrap('GIT_PAGER=cat git log')).toBe('GIT_PAGER=cat rtk git log');
      expect(rtkWrap('FOO=1 cd /tmp && NODE_ENV=test npm test'))
        .toBe('FOO=1 cd /tmp && NODE_ENV=test rtk npm test');
    });

    it('leaves backgrounding and newline-separated lines intact', () => {
      expect(rtkWrap('git log &')).toBe('rtk git log &');
      expect(rtkWrap('cd /tmp\ngit diff')).toBe('cd /tmp\nrtk git diff');
    });
  });

  describe('quoting', () => {
    beforeEach(installRtk);

    it('does not treat a quoted operator as an operator', () => {
      expect(rtkWrap('echo "a && b"')).toBe('echo "a && b"');
      expect(rtkWrap("grep 'a && \"b\"' file")).toBe("rtk grep 'a && \"b\"' file");
      expect(rtkWrap('echo "a | b ; c"')).toBe('echo "a | b ; c"');
    });

    it('handles a command carrying both quote types at once', () => {
      const cmd = `git commit -m "it's a \\"quoted\\" mess" && git log --oneline`;
      expect(rtkWrap(cmd))
        .toBe(`rtk git commit -m "it's a \\"quoted\\" mess" && rtk git log --oneline`);

      const single = `grep 'he said "it'\\''s fine"' notes.txt | wc -l`;
      expect(rtkWrap(single)).toBe(`rtk grep 'he said "it'\\''s fine"' notes.txt | rtk wc -l`);
    });

    it('refuses to rewrite anything when a heredoc is present', () => {
      // The body is arbitrary text; a line reading `git diff` is content, not a
      // command, and must not acquire an `rtk` prefix.
      const cmd = "cat <<'EOF' > f.txt\ngit diff\nEOF";
      expect(rtkWrap(cmd)).toBe(cmd);
    });

    it('preserves every byte it does not deliberately insert', () => {
      const cmd = '  git   diff   --stat   &&    git log  ';
      expect(rtkWrap(cmd)).toBe('  rtk git   diff   --stat   &&    rtk git log  ');
      // Stripping the inserted prefixes must give back the input exactly.
      expect(rtkWrap(cmd).split('rtk ').join('')).toBe(cmd);
    });

    it('does not wrap rtk subcommands that collide with shell commands', () => {
      // rtk's `test` runs a test suite, `read` reads a file, `env` prints vars —
      // none of which is what these shell commands mean.
      expect(rtkWrap('test -f package.json && git diff'))
        .toBe('test -f package.json && rtk git diff');
      expect(rtkWrap('read line')).toBe('read line');
      expect(rtkWrap('env FOO=1 git log')).toBe('env FOO=1 git log');
    });
  });
});

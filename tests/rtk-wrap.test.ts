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

    it('wraps past a variable-assignment prefix, leaving the assignment in place', () => {
      // The assignment is not the command head — `git` is — and rtk inherits
      // the variable because it is exported for the command it fronts. The
      // earlier allowlist-only wrapper gave up here and left the call
      // unfiltered; the segment scanner finds the real head instead.
      expect(rtkWrap('FOO=1 git diff')).toBe('FOO=1 rtk git diff');
    });

    it('does not rewrite shell compound syntax it cannot read safely', () => {
      // `cd` leads and is not proxied, but `ls` is its own top-level segment
      // and does get filtered — the whole point of scanning segments rather
      // than only the first word.
      expect(rtkWrap('cd /tmp && ls')).toBe('cd /tmp && rtk ls');
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

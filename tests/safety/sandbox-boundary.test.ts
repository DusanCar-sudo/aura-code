/**
 * The sandbox has to be tested by attacking it.
 *
 * Every other guard in src/safety/ can be unit-tested by calling it and
 * checking what it returns. This one is a claim about the kernel, so asserting
 * that `buildBwrapArgv` contains the right strings would prove nothing about
 * whether a write actually fails. The boundary cases below therefore run real
 * bwrap and try to perform the write.
 *
 * They skip when bwrap is missing rather than failing, and that skip is
 * deliberately loud in intent: a benchmark that self-skips is
 * indistinguishable from one that passes, so the suite must never report a
 * verified boundary on a machine that has no mechanism to enforce one.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  SANDBOX_ACTIVE_ENV,
  buildBwrapArgv,
  detectSandboxMechanism,
  inSandbox,
  installInsideProject,
  sandboxBanner,
  sandboxPreflight,
} from '../../src/safety/sandbox.js';
import { checkComputerUseGate } from '../../src/tools/screen/disclosure.js';

function bwrapAvailable(): boolean {
  try {
    return spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'],
      { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

const HAS_BWRAP = bwrapAvailable();

describe('sandbox preflight', () => {
  it('refuses computer use and --sandboxed together', () => {
    const result = sandboxPreflight({
      projectRoot: os.tmpdir(),
      computerUse: true,
      platform: 'linux',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cannot be enabled together/);
  });

  it('refuses on a platform with no mechanism, rather than running unprotected', () => {
    const result = sandboxPreflight({
      projectRoot: os.tmpdir(),
      computerUse: false,
      platform: 'win32',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Linux-only/);
  });

  it('names macOS as designed-but-unimplemented instead of claiming support', () => {
    const { mechanism, reason } = detectSandboxMechanism(process.env, 'darwin');
    expect(mechanism).toBeNull();
    expect(reason).toMatch(/not implemented/);
  });

  it('collects every blocker at once, so one restart fixes all of them', () => {
    const result = sandboxPreflight({
      projectRoot: os.tmpdir(),
      computerUse: true,
      platform: 'win32',
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses when the project contains the running install — G1 and G2 cannot both hold there', () => {
    const repo = path.resolve(__dirname, '..', '..');
    expect(installInsideProject({
      installDir: repo,
      projectRoot: repo,
      stateDir: '/home/nobody/.aura',
    })).toBe(true);

    // A sibling directory is not "inside", and a prefix match on the string
    // alone would wrongly say it is.
    expect(installInsideProject({
      installDir: '/opt/aura-code-nightly',
      projectRoot: '/opt/aura-code',
      stateDir: '/home/nobody/.aura',
    })).toBe(false);
  });
});

describe('the bwrap invocation', () => {
  const paths = {
    installDir: '/opt/aura-code',
    projectRoot: '/home/dev/project',
    stateDir: '/home/dev/.aura',
  };

  it('binds the root read-only, so an unlisted path fails closed', () => {
    const argv = buildBwrapArgv(paths, ['node', 'x.js']);
    expect(argv.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    // --dev-bind / / would leave the entire filesystem writable and deliver G1
    // alone. If this ever appears, both guarantees are gone.
    expect(argv).not.toContain('--dev-bind');
  });

  it('makes the project and the state dir writable, and nothing else', () => {
    const argv = buildBwrapArgv(paths, ['node', 'x.js'], { tmpdir: '/tmp' });
    const writable: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--bind') writable.push(argv[i + 1]);
    }
    expect(writable).toEqual(['/home/dev/project', '/home/dev/.aura']);
    expect(writable).not.toContain('/opt/aura-code');
  });

  it('gives /tmp a private tmpfs rather than binding the host one', () => {
    // Binding the real /tmp read-write would be a hole in G2 — it is outside
    // the project and readable by every user on the box. The first draft did
    // exactly that, and the boundary test below caught it by "successfully"
    // writing a file it was supposed to be unable to touch.
    const argv = buildBwrapArgv(paths, ['node', 'x.js'], { tmpdir: '/tmp' });
    expect(argv).toContain('--tmpfs');
    expect(argv[argv.indexOf('--tmpfs') + 1]).toBe('/tmp');
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--bind') expect(argv[i + 1]).not.toBe('/tmp');
    }
  });

  it('mounts the private tmp before the writable binds, so a project under /tmp survives', () => {
    // Ordering is load-bearing: bwrap applies these left to right, and a tmpfs
    // mounted after the project bind hides the project completely. That was
    // the first version, and it presented as the worst kind of failure — the
    // agent saw an empty directory and no error at all.
    const argv = buildBwrapArgv(
      { installDir: '/opt/aura-code', projectRoot: '/tmp/my-app', stateDir: '/home/dev/.aura' },
      ['node', 'x.js'], { tmpdir: '/tmp' },
    );
    expect(argv.indexOf('--tmpfs')).toBeLessThan(argv.indexOf('--bind'));
  });

  it('passes the command after the -- separator', () => {
    const argv = buildBwrapArgv(paths, ['node', 'dist/cli/index.js', 'do a thing']);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['node', 'dist/cli/index.js', 'do a thing']);
  });
});

describe('the banner', () => {
  it('states the non-guarantee as plainly as the guarantees', () => {
    const text = sandboxBanner({
      installDir: '/opt/aura-code',
      projectRoot: '/home/dev/project',
      stateDir: '/home/dev/.aura',
    });
    expect(text).toMatch(/NOT guaranteed/);
    expect(text).toMatch(/run arbitrary code/);
  });
});

describe('computer use inside a sandbox', () => {
  it('is refused even with the flag, the env var and a prior acknowledgement', () => {
    // Every key that normally opens the gate, all at once. The sandbox still
    // wins — otherwise :compon would be a documented way around the boundary.
    const gate = checkComputerUseGate(true, {
      AURA_COMPUTER_USE: '1',
      [SANDBOX_ACTIVE_ENV]: '1',
    } as NodeJS.ProcessEnv);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/sandboxed/i);
    // Not a consent prompt: there is nothing the user can accept here.
    expect(gate.needsDisclosure).toBeFalsy();
  });

  it('detects the active sandbox only from an exact marker', () => {
    expect(inSandbox({ [SANDBOX_ACTIVE_ENV]: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(inSandbox({ [SANDBOX_ACTIVE_ENV]: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(inSandbox({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

/**
 * The cases that distinguish a real boundary from a broken install. Each one
 * runs bwrap for real and asserts on what the kernel did, not on what the argv
 * said.
 */
describe.skipIf(!HAS_BWRAP)('the boundary, enforced', () => {
  let project: string;
  let install: string;
  let state: string;
  let outside: string;
  let sandboxTmp: string;

  const paths = () => ({ installDir: install, projectRoot: project, stateDir: state });

  /** Attempt a write inside the sandbox; returns the shell's stderr and code. */
  function attemptWrite(target: string) {
    // The fixtures live under the host's temp dir, so the sandbox's private
    // tmpfs is pointed somewhere else — otherwise it would mount over them and
    // every assertion below would be about an empty directory.
    const argv = buildBwrapArgv(paths(), ['sh', '-c', `echo tampered > ${JSON.stringify(target)}`],
      { tmpdir: sandboxTmp });
    const r = spawnSync('bwrap', argv, { encoding: 'utf8', timeout: 15_000 });
    return { status: r.status, stderr: r.stderr ?? '' };
  }

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sandbox-'));
    project = path.join(base, 'project');
    install = path.join(base, 'install', 'dist', 'safety');
    state   = path.join(base, 'state');
    outside = path.join(base, 'outside');
    sandboxTmp = path.join(base, 'sandbox-tmp');
    for (const d of [project, install, state, outside, sandboxTmp]) fs.mkdirSync(d, { recursive: true });
    // The guard files the design names explicitly.
    fs.writeFileSync(path.join(install, 'permissions.js'), 'ORIGINAL');
    fs.mkdirSync(path.join(base, 'install', 'dist', 'tools', 'screen'), { recursive: true });
    fs.writeFileSync(path.join(base, 'install', 'dist', 'tools', 'screen', 'disclosure.js'), 'ORIGINAL');
    fs.writeFileSync(path.join(outside, 'authorized_keys'), 'ORIGINAL');
    // installDir is the package root, not the safety directory.
    install = path.join(base, 'install');
  });

  afterAll(() => {
    try { fs.rmSync(path.dirname(project), { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('cannot rewrite the permission system — and the file is byte-unchanged', () => {
    const target = path.join(install, 'dist', 'safety', 'permissions.js');
    const { status, stderr } = attemptWrite(target);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/[Rr]ead-only file system|Permission denied/);
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  it('cannot rewrite the computer-use disclosure', () => {
    const target = path.join(install, 'dist', 'tools', 'screen', 'disclosure.js');
    const { status } = attemptWrite(target);
    expect(status).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  it('cannot write outside the project — with path-jail.ts out of the picture entirely', () => {
    // This is G2, and the point of doing it here rather than in a unit test is
    // that no TypeScript check is involved: the write is attempted by `sh`
    // inside the namespace, and it is the kernel that refuses.
    const target = path.join(outside, 'authorized_keys');
    const { status, stderr } = attemptWrite(target);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/[Rr]ead-only file system|Permission denied/);
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  it('still lets the agent work — a write inside the project succeeds', () => {
    // A boundary that breaks the agent is not a boundary, it is an outage.
    const target = path.join(project, 'index.html');
    const { status } = attemptWrite(target);
    expect(status).toBe(0);
    expect(fs.readFileSync(target, 'utf8').trim()).toBe('tampered');
  });

  it('still lets sessions and the cost ledger be written', () => {
    const target = path.join(state, 'sessions.json');
    expect(attemptWrite(target).status).toBe(0);
  });

  it('runs node, so the re-exec has something to re-exec into', () => {
    const argv = buildBwrapArgv(paths(), [process.execPath, '-e', 'process.stdout.write("alive")'],
      { tmpdir: sandboxTmp });
    const r = spawnSync('bwrap', argv, { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('alive');
  });

  it('keeps host networking, so the local model path still works', () => {
    // The economic argument of the whole project runs through Ollama on
    // localhost. A sandbox that severed it would be correct and unused.
    const argv = buildBwrapArgv(paths(), [
      process.execPath, '-e',
      'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write("bound");s.close()})',
    ], { tmpdir: sandboxTmp });
    const r = spawnSync('bwrap', argv, { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('bound');
  });
});

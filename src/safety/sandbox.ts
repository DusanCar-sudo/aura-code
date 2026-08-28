/**
 * `--sandboxed`: a boundary the agent's own UID cannot rescind.
 *
 * Everything else in `src/safety/` is ordinary TypeScript running in the same
 * process, with the same UID, as the agent it constrains — `run_shell` and
 * `write_file` are enough to edit any of it and rebuild. Those guards stop
 * accidents. SECURITY.md says so plainly, and this module exists because
 * saying so is not the same as fixing it.
 *
 * Two guarantees, both enforced by the kernel:
 *
 *   G1 — tampering cannot persist. Aura's installed tree is read-only from
 *        inside, so nothing a session does changes what the next one enforces.
 *   G2 — the blast radius is the project. Writes outside the project root and
 *        the state directory fail with EROFS, not with a path-jail check.
 *
 * And one non-guarantee that must never be quietly upgraded into a promise:
 *
 *   NOT G3 — the agent can still run arbitrary code. `run_shell` exists by
 *        design; inside the sandbox it can still write a script and execute
 *        it. The honest claim is "tampering cannot persist and writes are
 *        bounded", never "the agent is contained".
 *
 * The mechanism is bubblewrap: an unprivileged user namespace, no root, no
 * daemon, no per-project chown, no startup penalty. The process keeps the host
 * network and the host display, so Ollama and the local Archimedes path keep
 * working — a sandbox that broke those would not get used, and an unused
 * boundary protects nobody.
 *
 * See docs/SANDBOX-DESIGN.md for the options weighed and rejected.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { auraHome } from '../util/aura-home.js';

/** Set on the re-executed inner process so it does not sandbox itself again. */
export const SANDBOX_ACTIVE_ENV = 'AURA_SANDBOX_ACTIVE';

export type SandboxMechanism = 'bubblewrap';

export interface MechanismResult {
  mechanism: SandboxMechanism | null;
  /** Why there is none, phrased for a user who has just been refused. */
  reason?: string;
}

/** True when this process is already running inside the sandbox. */
export function inSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SANDBOX_ACTIVE_ENV] === '1';
}

/** First directory on PATH holding an executable `name`, or undefined. */
function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return undefined;
}

/**
 * Whether `bwrap` can actually create a namespace here — established by making
 * one, not by reading a sysctl.
 *
 * Unprivileged user namespaces are off by default on some distributions and
 * can be restricted further by AppArmor, seccomp or a container runtime, and
 * each of those refuses at a different layer. The only answer that is worth
 * anything is whether the call succeeds, so the probe runs the real thing on a
 * trivial command. This is the same lesson the computer-use work paid for on
 * Linux: three of four input paths accepted every call and silently did
 * nothing, which is why an exit code from the real operation is the only
 * evidence accepted here.
 */
function bwrapWorks(bwrap: string): boolean {
  const probe = spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  return probe.status === 0;
}

/** The sandbox mechanism available on this machine, if any. */
export function detectSandboxMechanism(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): MechanismResult {
  if (platform !== 'linux') {
    // Stated rather than implied: macOS has sandbox-exec (deprecated but
    // functional) and is a real future option; Windows has no equivalent we
    // are prepared to stand behind. Neither is claimed until it is verified on
    // that platform's own hardware.
    return {
      mechanism: null,
      reason: platform === 'darwin'
        ? '--sandboxed is Linux-only for now. macOS support (sandbox-exec) is designed but not implemented, '
          + 'and will not be claimed before it is verified on a Mac.'
        : `--sandboxed is Linux-only. There is no supported mechanism on ${platform}.`,
    };
  }

  const bwrap = onPath('bwrap', env);
  if (!bwrap) {
    return {
      mechanism: null,
      reason: 'bubblewrap is not installed. Install it (Debian/Ubuntu: apt install bubblewrap, '
        + 'Fedora: dnf install bubblewrap, Arch: pacman -S bubblewrap) and try again.',
    };
  }

  if (!bwrapWorks(bwrap)) {
    return {
      mechanism: null,
      reason: `${bwrap} is installed but cannot create a user namespace here. Unprivileged user `
        + 'namespaces are probably disabled (check /proc/sys/kernel/unprivileged_userns_clone and '
        + '/proc/sys/user/max_user_namespaces), or a container or LSM policy is blocking them.',
    };
  }

  return { mechanism: 'bubblewrap' };
}

export interface SandboxPaths {
  /** Aura's installed tree — the thing that must be read-only. */
  installDir: string;
  /** The project being worked on — the one place writes are expected. */
  projectRoot: string;
  /** Per-user state: sessions, episodes, the cost ledger. Writable. */
  stateDir: string;
}

/**
 * Where the running Aura lives: the package root, two levels above
 * `dist/cli/index.js`.
 */
export function installDir(): string {
  return path.resolve(__dirname, '..', '..');
}

/** The paths the sandbox is built around, resolved through symlinks so the
 *  binds name the same files the kernel will check. */
export function sandboxPaths(projectRoot: string): SandboxPaths {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return {
    installDir:  real(installDir()),
    projectRoot: real(projectRoot),
    stateDir:    real(auraHome()),
  };
}

/**
 * True when the project being worked on contains the running install — the one
 * situation where G1 and G2 cannot both hold.
 *
 * In a development checkout they are the same tree: `which aura` resolves to
 * `<repo>/dist/cli/index.js`. G1 wants that read-only; G2 wants the project
 * writable. No filesystem boundary can tell "legitimate work on Aura" apart
 * from "editing the thing that says no", so `--sandboxed` refuses instead of
 * appearing to work. This means it does not protect work on Aura itself — it
 * protects users running Aura against other projects, which is the deployment
 * that exists.
 */
export function installInsideProject(paths: SandboxPaths): boolean {
  const { installDir: inst, projectRoot: root } = paths;
  return inst === root || inst.startsWith(root + path.sep);
}

export interface PreflightOptions {
  projectRoot: string;
  /** Whether this invocation also asked for computer use. */
  computerUse: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface PreflightResult {
  ok: boolean;
  mechanism?: SandboxMechanism;
  paths?: SandboxPaths;
  /** Every reason it cannot run, so one restart fixes all of them. */
  errors: string[];
}

/**
 * Everything that must hold before a sandboxed run starts. Refusals are
 * collected rather than short-circuited: being told about one blocker, fixing
 * it, and being told about the next is three restarts for one answer.
 */
export function sandboxPreflight(opts: PreflightOptions): PreflightResult {
  const errors: string[] = [];

  // Computer use and --sandboxed are mutually exclusive, and this is not
  // conservatism. The sandbox is a *filesystem* boundary; a process that can
  // drive the user's keyboard can open a terminal outside the jail and do
  // anything the user could. Allowing both would leave the flag technically
  // accurate and practically misleading, which is the failure mode this whole
  // feature exists to remove.
  if (opts.computerUse) {
    errors.push(
      'Computer use and --sandboxed cannot be enabled together. The sandbox bounds the filesystem; '
      + 'a process that can drive the keyboard can open a terminal outside it, which would make the '
      + 'boundary meaningless. Choose one.',
    );
  }

  const detected = detectSandboxMechanism(opts.env, opts.platform);
  if (!detected.mechanism) errors.push(detected.reason!);

  const paths = sandboxPaths(opts.projectRoot);
  if (installInsideProject(paths)) {
    errors.push(
      `--sandboxed cannot protect a project that contains the running Aura (install: ${paths.installDir}, `
      + `project: ${paths.projectRoot}). The install must be read-only and the project must be writable, `
      + 'and here they are the same tree. Run Aura from an installed copy elsewhere, or work without the flag.',
    );
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, mechanism: detected.mechanism!, paths, errors: [] };
}

/**
 * The bubblewrap argv for re-executing this process inside the sandbox.
 *
 * The root bind is `--ro-bind`, not `--dev-bind`. Read-only by default with
 * explicit read-write exceptions is what yields both guarantees, and it fails
 * closed: a path nobody thought about is read-only rather than writable. An
 * earlier sketch used `--dev-bind / /`, which leaves the whole filesystem
 * writable and delivers G1 alone.
 */
export function buildBwrapArgv(
  paths: SandboxPaths,
  command: string[],
  opts: { tmpdir?: string } = {},
): string[] {
  const tmp = opts.tmpdir ?? os.tmpdir();
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    // Writable, in the order they are argued for in the design: the project is
    // the work, the state dir is the record of it, and a temp dir because
    // half the toolchain writes there and a read-only /tmp breaks builds
    // rather than containing them.
    // A *private* tmp, not the host's. Half the toolchain writes to /tmp and a
    // read-only one breaks builds rather than containing them — but binding
    // the real /tmp read-write would punch a hole straight through G2, since
    // /tmp is outside the project and every user on the box can read it. A
    // tmpfs keeps builds working and dies with the sandbox. Caught by the
    // boundary test, which passed a write to a file outside the project purely
    // because that file happened to live under /tmp.
    //
    // It must come BEFORE the writable binds, because bwrap applies these in
    // order and a later tmpfs mounts straight over anything beneath it. With
    // the tmpfs last, a project at /tmp/my-app — or any checkout under the
    // system temp dir — appeared inside the sandbox as an empty directory, and
    // the agent would have worked in it and written nothing anywhere real.
    // Mounted first, the project bind lands on top and the file is there.
    '--tmpfs', tmp,
    '--bind', paths.projectRoot, paths.projectRoot,
    '--bind', paths.stateDir, paths.stateDir,
    // Config stays read-only on purpose. ~/.config/aura-code/config.json can
    // carry a default permission level, so a writable config would be a small
    // channel for persisting a weakened setting into the next session — the
    // exact thing G1 exists to prevent. State and config already live in
    // different directories, so the split costs nothing.
    '--die-with-parent',
    '--',
    ...command,
  ];
}

/** The startup banner, in the same plain register SECURITY.md uses. */
export function sandboxBanner(paths: SandboxPaths): string {
  return [
    'Sandboxed (bubblewrap).',
    `  read-only   ${paths.installDir}  — and everything else outside the two lines below`,
    `  writable    ${paths.projectRoot}`,
    `  writable    ${paths.stateDir}`,
    '  Guaranteed: tampering with Aura\'s guards cannot persist, and writes outside the project fail at the OS level.',
    '  NOT guaranteed: the agent can still run arbitrary code inside the sandbox. This bounds the blast radius; it does not contain an adversarial agent.',
  ].join('\n');
}

/**
 * Re-exec the current process inside the sandbox and return its exit code.
 *
 * The inner process is the same argv with `AURA_SANDBOX_ACTIVE=1` set, so it
 * skips this path and runs normally. stdio is inherited: the REPL is
 * interactive and anything else would break it.
 */
export function reexecSandboxed(paths: SandboxPaths, env: NodeJS.ProcessEnv = process.env): number {
  const command = [process.execPath, ...process.argv.slice(1)];
  const result = spawnSync('bwrap', buildBwrapArgv(paths, command), {
    stdio: 'inherit',
    env: { ...env, [SANDBOX_ACTIVE_ENV]: '1' },
  });
  if (result.error) {
    process.stderr.write(`aura: could not start the sandbox: ${result.error.message}\n`);
    return 1;
  }
  // A killed child reports a signal and a null status; turn that into the
  // conventional 128+n rather than a silent 0.
  if (result.status === null && result.signal) return 128 + (os.constants.signals[result.signal] ?? 0);
  return result.status ?? 1;
}

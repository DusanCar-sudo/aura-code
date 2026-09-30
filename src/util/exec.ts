/**
 * One way to run another program: an argv array, never a shell string.
 *
 * Socket.dev's review of 0.18.0 (docs/security/socket-alerts-0.18.0.md)
 * found the same bug in many shapes: a path, a URL or a model-supplied
 * value pasted into `execSync(\`tool "${x}"\`)`. Quoting doesn't save that —
 * a `"` or `$(…)` inside `x` is shell syntax. With an argv array there is no
 * shell to interpret anything, so the value can only ever be one argument.
 *
 * Callers that genuinely run a user's shell command (run_shell, a cron
 * line, a test command) do so on purpose and elsewhere; this module is for
 * everything that only wants to invoke a known program.
 */

import { spawnSync, type SpawnSyncOptions } from 'child_process';

export interface RunOptions {
  cwd?: string;
  /** Replaces the environment entirely. Default: {@link minimalEnv}(). */
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin. */
  input?: string | Buffer;
  /** Default 60 s. */
  timeoutMs?: number;
  /** Default 32 MB. */
  maxBuffer?: number;
}

export interface RunResult {
  /** Exit code; null when killed (timeout) or it never started. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (e.g. ENOENT) or timed out. */
  error?: Error;
}

/**
 * What a child needs to behave normally on a desktop — and nothing else. In
 * particular no provider keys or tokens from this process's environment
 * (Aura loads ~/.aura/.env into process.env): a helper program has no
 * business seeing them.
 */
const PASS_THROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TERM',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
  'SWAYSOCK', 'PULSE_SERVER', 'PIPEWIRE_REMOTE',
  // Windows
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
];

export function minimalEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LC_') && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Run `cmd` with `args`, no shell. Never throws; inspect the result. */
export function run(cmd: string, args: readonly string[], o: RunOptions = {}): RunResult {
  const opts: SpawnSyncOptions = {
    cwd: o.cwd,
    env: o.env ?? minimalEnv(),
    input: o.input,
    timeout: o.timeoutMs ?? 60_000,
    maxBuffer: o.maxBuffer ?? 32 * 1024 * 1024,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  };
  const r = spawnSync(cmd, [...args], opts);
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: r.error,
  };
}

/** True when `cmd` resolves on PATH (checked without a shell). */
export function hasCommand(cmd: string): boolean {
  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) return false;
  const r = process.platform === 'win32'
    ? run('where', [cmd], { timeoutMs: 5000 })
    : run('sh', ['-c', 'command -v "$1"', 'sh', cmd], { timeoutMs: 5000 });
  return r.status === 0;
}

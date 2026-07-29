import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// RTK (Rust Token Killer) command wrapping.
//
// Aura's shell and git tools shell out through Node's exec/execSync, which the
// RTK shell hook never sees — it only rewrites commands typed at a terminal. So
// raw `git diff`/`git log`/`grep` output reached the context window
// uncompressed, and the bloat compounded across a session (measured: 1.28M
// input tokens over three tasks, versus 253K once every call site was proxied).
//
// Prefixing `rtk` unconditionally would make it a hard runtime dependency of a
// published npm package: every `run_shell` call on a machine without it would
// come back "rtk: command not found". So availability is probed once, from PATH,
// and the bare command is used when it isn't there.
// ─────────────────────────────────────────────────────────────────────────────

/** Memoized probe result. null = not looked yet. */
let available: boolean | null = null;

/** Look for an executable `rtk` on PATH. Deliberately a filesystem scan rather
 *  than spawning `which`/`where`: no child process, and no dependency on which
 *  lookup tool the host happens to have. */
function probePath(): boolean {
  const raw = process.env.PATH ?? '';
  if (!raw) return false;
  // On Windows the extension is what makes a file executable, and accessSync's
  // X_OK is not meaningful there — check the PATHEXT candidates by name instead.
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, `rtk${ext}`), fs.constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

/**
 * Is the RTK proxy usable for this process?
 *
 * `AURA_RTK=0` forces it off (raw commands, e.g. when debugging what a tool
 * actually ran); `AURA_RTK=1` forces it on without probing. Otherwise PATH
 * decides, once per process — a tool that runs on every shell call cannot
 * afford to re-scan PATH each time.
 */
export function rtkAvailable(): boolean {
  const override = process.env.AURA_RTK;
  if (override === '0' || override === 'false') return false;
  if (override === '1' || override === 'true') return true;
  if (available === null) available = probePath();
  return available;
}

/** Forget the probe result. Tests only — PATH does not change under a session. */
export function resetRtkProbe(): void {
  available = null;
}

/**
 * `command` routed through RTK when it is installed, unchanged when it isn't.
 * Already-prefixed commands are left alone so wrapping stays idempotent.
 */
export function rtkWrap(command: string): string {
  if (!command) return command;
  if (/^\s*rtk\s/.test(command)) return command;
  return rtkAvailable() ? `rtk ${command}` : command;
}

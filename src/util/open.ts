// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform "open this in the default handler"
// Every caller that shells out to `xdg-open` works on Linux and silently does
// nothing on macOS/Windows, so anything relying on it (the served web UI, the
// dashboard) was Linux-only. One helper, used by all of them.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'child_process';

/**
 * Open a file path or URL in the OS default handler. Best-effort: never throws
 * and never blocks — a machine with no browser (a headless server, a container)
 * is a normal thing to run on, not an error.
 */
export function openExternal(target: string): void {
  try {
    if (process.platform === 'darwin') {
      execFile('open', [target], () => {});
    } else if (process.platform === 'win32') {
      // `start` is a cmd builtin, not an executable, so it needs a shell. The
      // empty "" is cmd's window-title argument — without it, a quoted target
      // is itself parsed as the title and nothing opens.
      execFile('cmd', ['/c', 'start', '', target], () => {});
    } else {
      execFile('xdg-open', [target], () => {});
    }
  } catch {
    /* no handler available — not worth surfacing */
  }
}

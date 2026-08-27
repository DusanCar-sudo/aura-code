/**
 * Where Aura keeps its state on this machine.
 *
 * One helper because there used to be thirty-three answers. `AURA_HOME` was
 * honoured by four files — the computer-use acknowledgement, the screen
 * lessons, and two memory modules — and hardcoded to `~/.aura` by the other
 * twenty-two. Setting it therefore moved *some* of Aura's state and left the
 * rest behind: memory and consent relocated, while Telegram config, email
 * config, saved sessions, recordings, plugins and the task queue stayed in the
 * old home. A setting that half-applies is worse than one that does not exist,
 * because it looks like it worked.
 *
 * Resolved per call, never captured in a module-level constant. A constant is
 * evaluated at import, which is before any test can stub the environment and
 * before a wrapper script can export anything — that is exactly how the
 * unified-memory module ended up reading a developer's real memory during a
 * test run.
 */

import * as os from 'os';
import * as path from 'path';

/** The root of Aura's per-user state directory. */
export function auraHome(): string {
  const override = process.env.AURA_HOME?.trim();
  return override ? override : path.join(os.homedir(), '.aura');
}

/** A path inside {@link auraHome}, e.g. auraPath('memory', 'identity.json'). */
export function auraPath(...segments: string[]): string {
  return path.join(auraHome(), ...segments);
}

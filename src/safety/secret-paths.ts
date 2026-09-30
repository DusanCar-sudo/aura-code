/**
 * Paths that hold credentials. Remote surfaces (the Telegram bot's /read,
 * /ls, /sendfile, /search) refuse them even for an allowed user: a stolen
 * phone or a hijacked Telegram session must not be one message away from
 * the PC's SSH keys and API tokens.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SECRET_DIRS = ['.ssh', '.gnupg', '.aura', '.password-store', '.docker', '.kube', '.aws', '.azure', '.config/gh', '.config/gcloud', '.local/share/keyrings'];
const SECRET_NAMES = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|.*\.(pem|key|p12|pfx|kdbx))$/i;

/** True when `p` (after resolving symlinks) is, or is inside, a credential store. */
export function isSecretPath(p: string, home = os.homedir()): boolean {
  let real = path.resolve(p);
  try { real = fs.realpathSync(real); } catch { /* not there yet: judge the name */ }
  if (SECRET_NAMES.test(path.basename(real))) return true;
  return SECRET_DIRS.some(d => {
    const dir = path.join(home, d);
    return real === dir || real.startsWith(dir + path.sep);
  });
}

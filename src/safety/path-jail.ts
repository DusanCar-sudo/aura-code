import * as fs from 'fs';
import * as path from 'path';

/**
 * Filesystem containment: every file tool must keep its target inside the
 * project root. Without this, a model-issued (or prompt-injected) path like
 * `../../../home/user/.ssh/authorized_keys` or an absolute `/etc/passwd`
 * resolves and reads/writes freely with the user's full privileges.
 */
export class PathJailError extends Error {
  constructor(public readonly inputPath: string) {
    super(`Path escapes the project root: ${inputPath}`);
    this.name = 'PathJailError';
  }
}

/**
 * Resolve the deepest existing ancestor of `p` through the real filesystem
 * (following symlinks), then re-append the not-yet-existing tail. This makes
 * containment checks robust against symlink escapes: a symlink anywhere in
 * the existing prefix is resolved to its real location before we compare,
 * while still allowing writes to paths that don't exist yet.
 */
function realpathAllowingMissing(p: string): string {
  let existing = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real: string;
  try { real = fs.realpathSync(existing); }
  catch { real = existing; }
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * Resolve `inputPath` (relative to `root`, or absolute) and guarantee the
 * result stays within `root`. Throws {@link PathJailError} on escape.
 * Absolute paths outside the root, `..` traversal, and symlink escapes are
 * all rejected.
 */
export function resolveInRoot(root: string, inputPath: string): string {
  const realRoot = realpathAllowingMissing(root);
  // path.resolve ignores realRoot when inputPath is absolute; the containment
  // check below is what actually rejects an out-of-root absolute path.
  const candidate = realpathAllowingMissing(path.resolve(realRoot, inputPath ?? ''));

  const rel = path.relative(realRoot, candidate);
  const escapes = rel === '..'
    || rel.startsWith('..' + path.sep)
    || path.isAbsolute(rel);
  if (escapes) throw new PathJailError(inputPath);

  return candidate;
}

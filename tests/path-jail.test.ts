import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveInRoot, PathJailError } from '../src/safety/path-jail.js';

describe('resolveInRoot', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-'));
    root = path.join(base, 'project');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  });
  afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

  it('resolves a relative path inside the root', () => {
    const p = resolveInRoot(root, 'src/index.ts');
    expect(p).toBe(path.join(fs.realpathSync(root), 'src', 'index.ts'));
  });

  it('allows a not-yet-existing nested path (for writes)', () => {
    expect(() => resolveInRoot(root, 'a/b/c/new.ts')).not.toThrow();
  });

  it('treats the root itself as inside', () => {
    expect(resolveInRoot(root, '.')).toBe(fs.realpathSync(root));
  });

  it('rejects ../ traversal escaping the root', () => {
    expect(() => resolveInRoot(root, '../outside/secret.txt')).toThrow(PathJailError);
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveInRoot(root, '/etc/passwd')).toThrow(PathJailError);
    expect(() => resolveInRoot(root, path.join(outside, 'secret.txt'))).toThrow(PathJailError);
  });

  it('rejects a symlink that escapes the root', () => {
    // A symlink inside the project pointing at an outside directory must not
    // become a read/write escape hatch.
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(() => resolveInRoot(root, 'link/secret.txt')).toThrow(PathJailError);
  });

  it('does not confuse a sibling dir with a shared prefix (project2 vs project)', () => {
    const sibling = path.join(path.dirname(root), 'project-evil');
    fs.mkdirSync(sibling);
    expect(() => resolveInRoot(root, '../project-evil/x')).toThrow(PathJailError);
  });
});

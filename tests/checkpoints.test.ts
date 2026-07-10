import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  pruneCheckpoints,
  deleteCheckpoint,
  gitDirOf,
} from '../src/checkpoints/engine.js';

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('checkpoints engine', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ckpt-'));
    sh(root, 'git', ['init', '-q']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'original a\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'original b\n');
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('creates a checkpoint and lists it newest-first', async () => {
    const cp = await createCheckpoint(root, 'first snapshot');
    expect(cp).not.toBeNull();
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    const cp2 = await createCheckpoint(root, 'second snapshot');
    expect(cp2).not.toBeNull();

    const all = await listCheckpoints(root);
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(cp2!.id);
    expect(all[0].label).toBe('second snapshot');
    expect(all[1].label).toBe('first snapshot');
  });

  it('dedupes: identical tree returns null instead of a new checkpoint', async () => {
    const cp = await createCheckpoint(root, 'once');
    expect(cp).not.toBeNull();
    const dup = await createCheckpoint(root, 'twice');
    expect(dup).toBeNull();
    expect((await listCheckpoints(root)).length).toBe(1);
  });

  it('captures untracked files', async () => {
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new file\n');
    await createCheckpoint(root, 'with untracked');
    fs.rmSync(path.join(root, 'untracked.txt'));

    await restoreCheckpoint(root);
    expect(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8')).toBe('new file\n');
  });

  it('respects .gitignore in snapshots', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.log\n');
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-q', '-m', 'ignore']);
    fs.writeFileSync(path.join(root, 'ignored.log'), 'noise\n');

    const cp = await createCheckpoint(root, 'snap');
    fs.writeFileSync(path.join(root, 'ignored.log'), 'changed noise\n');
    await restoreCheckpoint(root, cp!.id);
    // Ignored file untouched by restore
    expect(fs.readFileSync(path.join(root, 'ignored.log'), 'utf8')).toBe('changed noise\n');
  });

  it('restore writes back modified files and deletes files created after the snapshot', async () => {
    const cp = await createCheckpoint(root, 'baseline');
    fs.writeFileSync(path.join(root, 'a.txt'), 'MODIFIED\n');
    fs.writeFileSync(path.join(root, 'new-file.txt'), 'should be deleted\n');
    fs.rmSync(path.join(root, 'b.txt'));

    const result = await restoreCheckpoint(root, cp!.id);

    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('original a\n');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('original b\n');
    expect(fs.existsSync(path.join(root, 'new-file.txt'))).toBe(false);
    expect(result.restored.sort()).toEqual(['a.txt', 'b.txt']);
    expect(result.deleted).toEqual(['new-file.txt']);
  });

  it('restore takes a pre-restore checkpoint so the restore is undoable', async () => {
    const cp = await createCheckpoint(root, 'baseline');
    fs.writeFileSync(path.join(root, 'a.txt'), 'work I want back\n');

    const result = await restoreCheckpoint(root, cp!.id);
    expect(result.preRestore).not.toBeNull();
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('original a\n');

    // Undo the undo
    await restoreCheckpoint(root, result.preRestore!.id);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('work I want back\n');
  });

  it('restore with no id targets the most recent checkpoint', async () => {
    await createCheckpoint(root, 'old');
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    await createCheckpoint(root, 'newest');
    fs.writeFileSync(path.join(root, 'a.txt'), 'v3\n');

    await restoreCheckpoint(root);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('restoring an unchanged tree is a no-op', async () => {
    const cp = await createCheckpoint(root, 'same');
    const result = await restoreCheckpoint(root, cp!.id);
    expect(result.restored).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('never touches HEAD, the branch, or the user index', async () => {
    const headBefore = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const cp = await createCheckpoint(root, 'snap');
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    await restoreCheckpoint(root, cp!.id);

    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    // status is clean because restore returned the tree to the committed state
    expect(sh(root, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('works in a repo with no commits yet (unborn HEAD)', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ckpt-fresh-'));
    try {
      sh(fresh, 'git', ['init', '-q']);
      fs.writeFileSync(path.join(fresh, 'only.txt'), 'hello\n');
      const cp = await createCheckpoint(fresh, 'unborn');
      expect(cp).not.toBeNull();
      fs.writeFileSync(path.join(fresh, 'only.txt'), 'bye\n');
      await restoreCheckpoint(fresh, cp!.id);
      expect(fs.readFileSync(path.join(fresh, 'only.txt'), 'utf8')).toBe('hello\n');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('is a silent no-op outside a git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ckpt-plain-'));
    try {
      expect(await gitDirOf(plain)).toBeNull();
      expect(await createCheckpoint(plain, 'nope')).toBeNull();
      expect(await listCheckpoints(plain)).toEqual([]);
      await expect(restoreCheckpoint(plain)).rejects.toThrow(/Not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('prunes old checkpoints beyond the keep limit', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, 'a.txt'), `v${i}\n`);
      await createCheckpoint(root, `snap ${i}`);
    }
    expect((await listCheckpoints(root)).length).toBe(5);
    const pruned = await pruneCheckpoints(root, 2);
    expect(pruned).toBe(3);
    const left = await listCheckpoints(root);
    expect(left.length).toBe(2);
    expect(left[0].label).toBe('snap 4');
    expect(left[1].label).toBe('snap 3');
  });

  it('deletes a single checkpoint by id', async () => {
    const cp = await createCheckpoint(root, 'to delete');
    expect(await deleteCheckpoint(root, cp!.id)).toBe(true);
    expect(await deleteCheckpoint(root, cp!.id)).toBe(false);
    expect((await listCheckpoints(root)).length).toBe(0);
  });

  it('handles filenames with spaces', async () => {
    fs.writeFileSync(path.join(root, 'my file.txt'), 'spaced\n');
    const cp = await createCheckpoint(root, 'spaces');
    fs.rmSync(path.join(root, 'my file.txt'));
    await restoreCheckpoint(root, cp!.id);
    expect(fs.readFileSync(path.join(root, 'my file.txt'), 'utf8')).toBe('spaced\n');
  });

  it('excludes files containing secrets from checkpoints', async () => {
    // Create a file with fake secrets
    const secretFile = path.join(root, 'config-with-secrets.json');
    fs.writeFileSync(secretFile, JSON.stringify({
      api_key: 'sk-1234567890abcdef1234567890abcdef',
      token: 'ghp_fake_token_for_testing_only',
      database_url: 'postgresql://user:SECRET_PASSWORD@localhost/db'
    }, null, 2));

    // Create a checkpoint - should exclude the secret file
    const cp = await createCheckpoint(root, 'with secrets');
    expect(cp).not.toBeNull();

    // Verify the secret file still exists in working directory
    expect(fs.existsSync(secretFile)).toBe(true);

    // Delete the secret file and restore from checkpoint
    fs.rmSync(secretFile);
    await restoreCheckpoint(root, cp!.id);

    // CRITICAL: The secret file should NOT be restored because it was excluded
    expect(fs.existsSync(secretFile)).toBe(false);

    // Clean up (file may not exist, so use force: true)
    try { fs.rmSync(secretFile); } catch { /* already gone */ }
  });

  it('excludes .env files with secrets', async () => {
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, 'API_KEY=sk_test_12345\nSECRET=super_secret_value\nTOKEN=abc123\n');

    const cp = await createCheckpoint(root, 'with .env');
    expect(cp).not.toBeNull();

    // Remove .env file and restore
    fs.rmSync(envFile);
    await restoreCheckpoint(root, cp!.id);

    // .env file should not be restored
    expect(fs.existsSync(envFile)).toBe(false);

    // Clean up (file may not exist, so use force: true)
    try { fs.rmSync(envFile); } catch { /* already gone */ }
  });

  it('excludes files with bearer tokens', async () => {
    const tokenFile = path.join(root, 'auth-config.sh');
    fs.writeFileSync(tokenFile, '#!/bin/bash\nexport AUTH_BEARER="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"\n');

    const cp = await createCheckpoint(root, 'with bearer token');
    expect(cp).not.toBeNull();

    fs.rmSync(tokenFile);
    await restoreCheckpoint(root, cp!.id);

    // Token file should not be restored
    expect(fs.existsSync(tokenFile)).toBe(false);

    // Clean up (file may not exist, so use force: true)
    try { fs.rmSync(tokenFile); } catch { /* already gone */ }
  });

  it('allows files without secret patterns', async () => {
    const normalFile = path.join(root, 'normal-config.json');
    fs.writeFileSync(normalFile, JSON.stringify({
      name: 'test-app',
      version: '1.0.0',
      description: 'Normal configuration without secrets'
    }, null, 2));

    const cp = await createCheckpoint(root, 'normal files only');
    expect(cp).not.toBeNull();

    fs.rmSync(normalFile);
    await restoreCheckpoint(root, cp!.id);

    // Normal file should be restored normally
    expect(fs.existsSync(normalFile)).toBe(true);
    expect(fs.readFileSync(normalFile, 'utf8')).toContain('test-app');

    fs.rmSync(normalFile);
  });
});

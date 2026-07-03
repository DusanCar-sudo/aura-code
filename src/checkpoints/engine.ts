/**
 * Checkpoints — shadow-git snapshots of the working tree, so every agent
 * write is cheaply reversible with `aura --undo` (or `:undo` in the REPL).
 *
 * How it works: before the first mutating tool call of each turn, the loop
 * snapshots the ENTIRE working tree (tracked + untracked, .gitignore
 * respected) into the repo's object store via a TEMPORARY index, then points
 * a ref at it under `refs/aura/checkpoints/<id>`. The user's real index,
 * HEAD, branches, and reflog are never touched — checkpoints are invisible
 * to normal git workflows and are garbage-collectable once pruned.
 *
 * Restore diffs the snapshot tree against a fresh snapshot of "now", writes
 * changed/added files back and deletes files that didn't exist at snapshot
 * time. A pre-restore checkpoint is always taken first, so restore itself
 * is undoable.
 *
 * Requires the project to be a git repository; in a non-repo all operations
 * are silent no-ops (create returns null).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Checkpoint {
  /** Short id, e.g. "m1x2y3-4f" — used in refs and CLI commands. */
  id: string;
  /** Full ref name: refs/aura/checkpoints/<id> */
  ref: string;
  /** Commit hash of the shadow commit. */
  commit: string;
  /** Tree hash of the snapshot. */
  tree: string;
  /** Human label (usually the task that triggered the snapshot). */
  label: string;
  /** ISO timestamp of creation. */
  createdAt: string;
}

export interface RestoreResult {
  /** Files written back from the snapshot. */
  restored: string[];
  /** Files deleted because they did not exist at snapshot time. */
  deleted: string[];
  /** Checkpoint of the state just before restoring (undo the undo). */
  preRestore: Checkpoint | null;
}

const REF_PREFIX = 'refs/aura/checkpoints/';

/** Shadow commits need an ident but must never depend on user git config. */
const SHADOW_IDENT = {
  GIT_AUTHOR_NAME: 'aura-checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@aura.local',
  GIT_COMMITTER_NAME: 'aura-checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@aura.local',
};

function git(root: string, args: string[], extraEnv?: Record<string, string>, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git', args,
      { cwd: root, env: { ...process.env, ...SHADOW_IDENT, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

/** Absolute .git dir of the repo containing root, or null if not a repo. */
export async function gitDirOf(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  } catch {
    return null;
  }
}

// Monotonic within the process so ids created in the same millisecond still
// sort in creation order (listCheckpoints sorts by refname).
let lastIdTs = 0;
function newId(): string {
  lastIdTs = Math.max(Date.now(), lastIdTs + 1);
  return `${lastIdTs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Snapshot the working tree into the object store through a temporary index.
 * Returns the tree hash. Never touches the user's real index.
 */
async function writeShadowTree(root: string, gitDir: string): Promise<string> {
  const tmpIndex = path.join(gitDir, `aura-checkpoint-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // Seed from HEAD when it exists so `add -A` computes a minimal update.
    try { await git(root, ['read-tree', 'HEAD'], env); }
    catch { await git(root, ['read-tree', '--empty'], env); }
    await git(root, ['add', '-A', '--', '.'], env);
    return (await git(root, ['write-tree'], env)).trim();
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* already gone */ }
  }
}

/**
 * Create a checkpoint of the current working tree.
 * Returns null when: not a git repo, or the tree is identical to the most
 * recent checkpoint (deduped — repeated calls within a burst are no-ops).
 */
export async function createCheckpoint(root: string, label: string): Promise<Checkpoint | null> {
  const gitDir = await gitDirOf(root);
  if (!gitDir) return null;

  const tree = await writeShadowTree(root, gitDir);

  const existing = await listCheckpoints(root);
  if (existing[0]?.tree === tree) return null;

  let head: string | null = null;
  try { head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch { /* unborn branch — parentless shadow commit */ }

  const cleanLabel = label.replace(/\s+/g, ' ').trim().slice(0, 120) || 'checkpoint';
  const commitArgs = ['commit-tree', tree, '-m', cleanLabel];
  if (head) commitArgs.push('-p', head);
  const commit = (await git(root, commitArgs)).trim();

  const id = newId();
  const ref = REF_PREFIX + id;
  await git(root, ['update-ref', ref, commit]);

  return { id, ref, commit, tree, label: cleanLabel, createdAt: new Date().toISOString() };
}

/** All checkpoints for the repo containing root, newest first. */
export async function listCheckpoints(root: string): Promise<Checkpoint[]> {
  const gitDir = await gitDirOf(root);
  if (!gitDir) return [];
  // Sort by refname, not creatordate: commit dates have 1-second resolution,
  // while ids embed a base36 ms timestamp that sorts correctly lexically.
  const out = await git(root, [
    'for-each-ref', '--sort=-refname',
    '--format=%(refname)%09%(objectname)%09%(tree)%09%(creatordate:iso-strict)%09%(subject)',
    REF_PREFIX,
  ]);
  return out.split('\n').filter(Boolean).map(line => {
    const [ref, commit, tree, createdAt, ...subject] = line.split('\t');
    return {
      id: ref.slice(REF_PREFIX.length),
      ref, commit, tree, createdAt,
      label: subject.join('\t'),
    };
  });
}

/**
 * Restore the working tree to the state captured by checkpoint `id`
 * (or the most recent checkpoint when id is omitted).
 *
 * Only paths that differ are touched; the user's index/HEAD stay put, so
 * after a restore `git status` simply reflects the restored content.
 */
export async function restoreCheckpoint(root: string, id?: string): Promise<RestoreResult> {
  const gitDir = await gitDirOf(root);
  if (!gitDir) throw new Error('Not a git repository — checkpoints unavailable.');

  const all = await listCheckpoints(root);
  if (all.length === 0) throw new Error('No checkpoints exist for this repository.');
  const target = id ? all.find(c => c.id === id) : all[0];
  if (!target) throw new Error(`Checkpoint not found: ${id}`);

  // Snapshot "now" first — makes the restore itself undoable, and gives us
  // the tree to diff against. createCheckpoint dedupes, so when the tree
  // hasn't changed since the latest checkpoint we reuse that one's tree.
  const preRestore = await createCheckpoint(root, `pre-restore (before restoring ${target.id})`);
  const nowTree = preRestore?.tree ?? (await listCheckpoints(root))[0].tree;

  if (nowTree === target.tree) return { restored: [], deleted: [], preRestore };

  // -z output: STATUS NUL path NUL … — statuses relative nowTree → target:
  //   A = exists only in the snapshot (write it back)
  //   D = exists only now (delete it)
  //   M/T = content/type differs (write it back)
  const raw = await git(root, ['diff-tree', '-r', '-z', '--name-status', nowTree, target.tree]);
  const parts = raw.split('\0').filter(p => p.length > 0);
  const toWrite: string[] = [];
  const toDelete: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const file = parts[i + 1];
    if (status === 'D') toDelete.push(file);
    else toWrite.push(file);
  }

  for (const file of toDelete) {
    try { fs.rmSync(path.join(root, file), { force: true }); } catch { /* best-effort */ }
  }

  if (toWrite.length > 0) {
    const tmpIndex = path.join(gitDir, `aura-restore-index-${process.pid}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await git(root, ['read-tree', target.tree], env);
      await git(root, ['checkout-index', '-f', '-z', '--stdin'], env, toWrite.join('\0') + '\0');
    } finally {
      try { fs.unlinkSync(tmpIndex); } catch { /* already gone */ }
    }
  }

  return { restored: toWrite, deleted: toDelete, preRestore };
}

/** Delete all but the newest `keep` checkpoints. Returns how many were pruned. */
export async function pruneCheckpoints(root: string, keep: number): Promise<number> {
  const all = await listCheckpoints(root);
  const stale = all.slice(Math.max(0, keep));
  for (const cp of stale) {
    await git(root, ['update-ref', '-d', cp.ref]);
  }
  return stale.length;
}

/** Delete a single checkpoint by id. */
export async function deleteCheckpoint(root: string, id: string): Promise<boolean> {
  const all = await listCheckpoints(root);
  const cp = all.find(c => c.id === id);
  if (!cp) return false;
  await git(root, ['update-ref', '-d', cp.ref]);
  return true;
}

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Memory consolidation — one-time (idempotent) migration that merges the 8
// overlapping ~/.aura/memory namespaces into a clean structure:
//
//   identity.json  — global identity/facts, prompt-visible everywhere
//                    (who Dušan is, who Aura is, preferences, relationship)
//   project.json   — machine/project state that isn't identity
//                    (paths, recovery notes, service state, tool locations)
//
// Originals are backed up to ~/.aura/memory/.pre-unify-<ts>/ first. Conflicting
// values for the same canonical key are PRESERVED as a CONFLICT entry rather
// than silently picking a winner (that's where auto-dedupe goes wrong).
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(os.homedir(), '.aura', 'memory');

type Entry = { value: string; updated?: string };
type Store = Record<string, Entry>;

// Keys that describe WHO Dušan/Aura are (global identity) vs machine state.
// Anything not listed as project-state defaults to identity.
const PROJECT_STATE_KEYS = new Set([
  'learnlight', 'linux-login-recovery', 'webcam-surveillance',
  'update-on-other-machines', 'personal-tools-location',
  'personal-content-save-location', 'sluzbeni-glasnik-grupa',
  'desktop-install-options', 'telegram-bot-status-line',
  'lessonprep_automation_path', 'clipai-pro', 'aura_code_path',
  'aura_code_status', 'system-recovery-state-2026-06-30',
  'weekly-backup-system', 'root-overflow-protection',
]);

// Namespaces that hold identity-ish content and should be merged.
const SOURCE_NAMESPACES = ['default', 'user', 'user_prefs', 'relationship', 'aura-core'];

function loadJson(file: string): Store {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Store) : {};
  } catch {
    return {};
  }
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ConsolidateResult {
  backupDir: string;
  identityKeys: number;
  projectKeys: number;
  conflicts: string[];
  alreadyDone: boolean;
}

/**
 * Merge the identity namespaces into identity.json + project.json.
 * Idempotent: if identity.json already exists it does nothing (unless force).
 */
export function consolidateMemory(opts: { force?: boolean } = {}): ConsolidateResult {
  const identityFile = path.join(MEMORY_DIR, 'identity.json');
  const projectFile = path.join(MEMORY_DIR, 'project.json');

  if (!opts.force && fs.existsSync(identityFile)) {
    return { backupDir: '', identityKeys: 0, projectKeys: 0, conflicts: [], alreadyDone: true };
  }

  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  // 1. Back up every source namespace first.
  const backupDir = path.join(MEMORY_DIR, `.pre-unify-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const ns of [...SOURCE_NAMESPACES, 'identity', 'project']) {
    const f = path.join(MEMORY_DIR, `${ns}.json`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backupDir, `${ns}.json`));
  }

  const identity: Store = {};
  const project: Store = {};
  const conflicts: string[] = [];

  // 2. Merge. A key already present with a DIFFERENT value becomes a CONFLICT
  //    entry that keeps both, tagged with their source namespaces.
  const place = (target: Store, ns: string, key: string, entry: Entry) => {
    const existing = target[key];
    if (!existing) {
      target[key] = { value: entry.value, updated: entry.updated };
      return;
    }
    if (norm(existing.value) === norm(entry.value)) return; // true duplicate — keep one
    // Genuine conflict: preserve both instead of picking a winner.
    const conflictKey = `${key}__CONFLICT`;
    if (!target[conflictKey]) {
      target[conflictKey] = {
        value: `[CONFLICT — reconcile manually]\n(A) ${existing.value}\n(B, from ${ns}) ${entry.value}`,
        updated: new Date().toISOString(),
      };
      conflicts.push(key);
    } else {
      target[conflictKey].value += `\n(+, from ${ns}) ${entry.value}`;
    }
  };

  for (const ns of SOURCE_NAMESPACES) {
    const store = loadJson(path.join(MEMORY_DIR, `${ns}.json`));
    for (const [key, entry] of Object.entries(store)) {
      const target = PROJECT_STATE_KEYS.has(key) ? project : identity;
      place(target, ns, key, entry);
    }
  }

  // 3. Write the consolidated stores.
  fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2), 'utf8');
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2), 'utf8');

  return {
    backupDir,
    identityKeys: Object.keys(identity).length,
    projectKeys: Object.keys(project).length,
    conflicts,
    alreadyDone: false,
  };
}

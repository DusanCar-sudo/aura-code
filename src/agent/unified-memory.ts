import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Unified Memory — one read path shared by the CLI and the Telegram bot.
//
// Aura's memory used to live in three disconnected places (see the plan/design):
//   1. key-value identity   ~/.aura/memory/*.json   (bot read default+user only)
//   2. episode→dream         ~/.aura/episodes + dreams/  (CLI read per-project)
//   3. chat history          ~/.aura/sessions
// Facts saved by one surface never reached the other. This module gives both
// surfaces ONE canonical view:
//   • GLOBAL identity/facts  →  ~/.aura/memory/identity.json   (everywhere)
//   • lessons                →  per-project reconciled dream (CLI) OR the
//                               global digest ~/.aura/memory/lessons-global.md
//                               (the bot, which is not tied to one project)
//
// It is read-only and defensive: any missing/corrupt file is skipped, and the
// whole block is length-capped so it never bloats a prompt.
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(os.homedir(), '.aura', 'memory');

/** Canonical global identity store (created by the consolidation migration). */
export const IDENTITY_FILE = path.join(MEMORY_DIR, 'identity.json');
/** Global episodic-lessons digest (created by runGlobalReconciliation). */
export const GLOBAL_LESSONS_FILE = path.join(MEMORY_DIR, 'lessons-global.md');

type Store = Record<string, { value: string; updated?: string }>;

function loadJson(file: string): Store {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function readText(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Identity/facts block from the canonical global store. Falls back to the
 * legacy default.json + user.json if identity.json hasn't been created yet
 * (so the surfaces keep working before/after the consolidation migration).
 */
function identitySection(maxChars: number): string {
  let store = loadJson(IDENTITY_FILE);
  if (Object.keys(store).length === 0) {
    // Pre-migration fallback: merge the two namespaces the bot used to read.
    store = { ...loadJson(path.join(MEMORY_DIR, 'default.json')), ...loadJson(path.join(MEMORY_DIR, 'user.json')) };
  }
  const keys = Object.keys(store);
  if (keys.length === 0) return '';

  // Most-recently-updated entries first: identity.json only grows, and a
  // budget-capped walk in raw insertion order silently drops whatever was
  // added most recently once older entries fill the budget — which is
  // exactly backwards, since a newly-added entry is usually a standing rule
  // or current fact, while old entries are stable background bio. A missing
  // `updated` sorts last (oldest-equivalent), not first.
  const ordered = [...keys].sort((a, b) => {
    const ta = Date.parse(store[a]?.updated ?? '') || 0;
    const tb = Date.parse(store[b]?.updated ?? '') || 0;
    return tb - ta;
  });

  const lines: string[] = [];
  let used = 0;
  for (const k of ordered) {
    const v = store[k]?.value ?? '';
    if (!v) continue;
    const line = `- **${k}**: ${v}`;
    if (used + line.length > maxChars) continue; // skip, don't stop — a later (older) entry may still fit
    lines.push(line);
    used += line.length;
  }
  return lines.length ? `### Who & what Aura knows (identity/facts)\n${lines.join('\n')}` : '';
}

/**
 * Lessons block. CLI passes a projectRoot → per-project reconciled dream.
 * The bot passes nothing → the global lessons digest.
 */
function lessonsSection(projectRoot: string | undefined, maxChars: number): string {
  let content = '';
  if (projectRoot) {
    const reconciled = path.join(projectRoot, 'dreams', '.reconciled.md');
    content = readText(reconciled);
    // Fall back to the latest dated dream if reconciliation hasn't run.
    if (!content) {
      try {
        const dir = path.join(projectRoot, 'dreams');
        const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
        if (files.length) content = readText(path.join(dir, files[files.length - 1]));
      } catch { /* no dreams yet */ }
    }
  } else {
    content = readText(GLOBAL_LESSONS_FILE);
  }
  content = content.trim();
  if (!content) return '';
  if (content.length > maxChars) content = content.slice(0, maxChars) + '\n… (truncated)';
  return `### Lessons from past sessions\n${content}`;
}

export interface UnifiedMemoryOptions {
  /** CLI passes its project root for per-project lessons; bot omits it. */
  projectRoot?: string;
  /** Total cap for the whole block (default ~4 KB). */
  maxChars?: number;
}

/**
 * The single memory block both the CLI and the Telegram bot inject into their
 * system prompts. Returns '' when there's nothing to add.
 */
export function loadUnifiedMemory(opts: UnifiedMemoryOptions = {}): string {
  const budget = opts.maxChars ?? 4000;
  // Split the budget: identity gets the larger share, lessons the rest.
  const idBlock = identitySection(Math.floor(budget * 0.6));
  const lessonBlock = lessonsSection(opts.projectRoot, budget - idBlock.length);

  const parts = [idBlock, lessonBlock].filter(Boolean);
  if (parts.length === 0) return '';
  return `\n\n## Memory (shared across Aura CLI + Telegram)\n${parts.join('\n\n')}\n`;
}

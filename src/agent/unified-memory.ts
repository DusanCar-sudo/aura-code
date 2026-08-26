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

/**
 * Resolved per call, not once at import.
 *
 * These were module-level constants pinned to os.homedir(), which had two
 * consequences. AURA_HOME — honoured everywhere else, including the
 * computer-use acknowledgement — did nothing here, so pointing Aura at a
 * different home moved some of its state and not the rest. And a test could
 * not isolate itself: stubbing the environment after import left the reads
 * pointing at the developer's real memory, which is how this was found.
 */
function memoryDir(): string {
  return path.join(process.env.AURA_HOME ?? path.join(os.homedir(), '.aura'), 'memory');
}

/** Canonical global identity store (created by the consolidation migration). */
export function identityFile(): string { return path.join(memoryDir(), 'identity.json'); }
/** Global episodic-lessons digest (created by runGlobalReconciliation). */
export function globalLessonsFile(): string { return path.join(memoryDir(), 'lessons-global.md'); }

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
  let store = loadJson(identityFile());
  if (Object.keys(store).length === 0) {
    // Pre-migration fallback: merge the two namespaces the bot used to read.
    store = { ...loadJson(path.join(memoryDir(), 'default.json')), ...loadJson(path.join(memoryDir(), 'user.json')) };
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
  // Global lessons are read on BOTH paths, not only the bot's.
  //
  // This used to be an either/or: with a projectRoot the CLI read the
  // project's dreams and never touched the global file. The effect was that a
  // fact true everywhere — a provider's model-id prefix, a library's real
  // signature — learned while working in one repo was invisible in every other
  // one, and got re-derived from scratch each time. That defeats the point of
  // writing it down, so the global digest is now always included and the
  // project's own lessons are added on top of it.
  const parts: string[] = [];

  const global = readText(globalLessonsFile()).trim();
  if (global) parts.push(global);

  if (projectRoot) {
    // The gap loop's project-scoped store (agent/learning.ts), then the older
    // dream-based lessons, which predate it and still carry real content.
    const learned = readText(path.join(projectRoot, '.aura', 'lessons.md')).trim();
    if (learned) parts.push(learned);

    let dreamt = readText(path.join(projectRoot, 'dreams', '.reconciled.md'));
    if (!dreamt) {
      try {
        const dir = path.join(projectRoot, 'dreams');
        const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
        if (files.length) dreamt = readText(path.join(dir, files[files.length - 1]));
      } catch { /* no dreams yet */ }
    }
    if (dreamt.trim()) parts.push(dreamt.trim());
  }

  let content = parts.join('\n\n').trim();
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

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle memory — the lean conversational read path.
//
// Gazelle mode is a conversation, not a coding session, so it must NOT pull the
// heavy blocks loadUnifiedMemory assembles (per-project reconciled dreams, the
// lessons digest, confessions). Those are task post-mortems — noise for a chat.
// It reads only two small files and hard-caps the whole thing so a warm prompt
// never turns into a dossier:
//   • identity.json      — static facts about who Aura is talking with
//   • conversational.md  — a rolling situational summary (written in Phase 2;
//                          absent for now, handled cleanly as empty)
// Deliberately does NOT read dreams/, confessions/, the episode store, or any
// session file.
// ─────────────────────────────────────────────────────────────────────────────

/** Rolling situational summary. Written in Phase 2; may not exist yet. */
export function conversationalFile(): string { return path.join(memoryDir(), 'conversational.md'); }

// Phase 2 raised the total cap from 800 → 1,000: a populated situation summary
// runs 400–600 chars and identity ~395, which overflowed 800. 1,000 chars is
// still tiny (~250 tokens) vs. the coder path's 6,000-char memory block, and it
// keeps a full situation from crowding out the identity line. Conversational
// (the more current signal) is read first and gets the larger per-field cap.
const GAZELLE_CONV_CAP = 600;
const GAZELLE_IDENTITY_CAP = 400;
/** Hard cap on identity + conversational combined. */
const GAZELLE_TOTAL_CAP = 1000;

export interface GazelleMemory {
  /** Distilled static facts from identity.json (≤400 chars, '' if none). */
  identity: string;
  /** Rolling situational summary from conversational.md (≤600 chars, '' if none). */
  conversational: string;
}

/** Trim to `max` chars on a whitespace-safe boundary, adding an ellipsis. */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '').trimEnd() + '…';
}

/**
 * Canonical person-identity keys, warmest summary first. identity.json also
 * accumulates operational entries — standing rules, "skills loaded" markers,
 * one-off event logs — that are noise in a conversation, so a plain
 * newest-wins walk surfaces exactly the wrong thing (a repo-hygiene rule as
 * "who you're talking with"). Prefer a clean bio; only fall back to recency,
 * and even then skip the operational markers.
 */
const IDENTITY_KEYS = ['briefing', 'creator-full', 'user-profile-dusan-milosavljevic', 'creator'];

/** True for entries that are agent/operational noise rather than person facts. */
function isOperationalFact(key: string, value: string): boolean {
  if (/rule|hygiene|skills?[-_]?loaded|status|post|appreciation/i.test(key)) return true;
  return /^\s*(STANDING RULE|✅|##\s|\[)/.test(value);
}

/**
 * Distill identity.json into a short warm blurb, clipped to `maxChars`. Uses
 * the first present canonical bio key; if none exist, walks the remaining
 * (non-operational) facts most-recently-updated first. Falls back to the
 * legacy default/user stores like identitySection, so it works before the
 * consolidation migration too.
 */
function distillIdentity(maxChars: number): string {
  let store = loadJson(identityFile());
  if (Object.keys(store).length === 0) {
    store = { ...loadJson(path.join(memoryDir(), 'default.json')), ...loadJson(path.join(memoryDir(), 'user.json')) };
  }

  // Preferred: a single clean, curated bio entry.
  for (const k of IDENTITY_KEYS) {
    const v = (store[k]?.value ?? '').trim();
    if (v) return clip(v, maxChars);
  }

  // Fallback: recent person facts, skipping operational noise.
  const ordered = Object.keys(store)
    .filter(k => !isOperationalFact(k, store[k]?.value ?? ''))
    .sort((a, b) => {
      const ta = Date.parse(store[a]?.updated ?? '') || 0;
      const tb = Date.parse(store[b]?.updated ?? '') || 0;
      return tb - ta;
    });
  let out = '';
  for (const k of ordered) {
    const v = (store[k]?.value ?? '').trim();
    if (!v) continue;
    const next = out ? `${out} ${v}` : v;
    if (next.length > maxChars) { if (!out) out = clip(v, maxChars); break; }
    out = next;
  }
  return out;
}

/**
 * The conversational read path for Gazelle mode. Reads identity + the rolling
 * situational summary only, never the task-lesson stores. Hard-capped at
 * GAZELLE_TOTAL_CAP chars total: the situational summary (more current signal)
 * takes its share first, and identity gets whatever budget remains.
 */
export function loadGazelleMemory(): GazelleMemory {
  const conversational = clip(readText(conversationalFile()), GAZELLE_CONV_CAP);
  const identityBudget = Math.min(GAZELLE_IDENTITY_CAP, GAZELLE_TOTAL_CAP - conversational.length);
  const identity = identityBudget > 0 ? distillIdentity(identityBudget) : '';
  return { identity, conversational };
}

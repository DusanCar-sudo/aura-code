import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { HistoryMessage } from '../providers/types.js';

/** Usage for a single provider API call, straight from the API response —
 *  never estimated. cost is computed from the same pricing table /stats uses.
 *  Defined here (not loop.ts) so session-store never imports the loop. */
export interface TurnUsage {
  turn: number;
  at: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** Real usage accumulated across every run saved into this session, sourced
 *  from provider API responses (LoopResult.usage / LoopResult.turnUsage) —
 *  never estimated from text. Absent on sessions saved before this existed. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** One entry per provider API call, across all runs, oldest first. */
  turns: TurnUsage[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: HistoryMessage[];
  usage?: SessionUsage;
  /** Absolute path of the project this session belongs to. Recorded on save so
   *  every surface (TUI, web) can show one merged, cross-project list and open
   *  any entry regardless of which directory it is currently in. Absent on
   *  sessions saved before this field existed — derived from the directory
   *  slug as a fallback. */
  projectRoot?: string;
}

/** Accumulate one run's real usage into a session's running totals. */
function mergeSessionUsage(existing: SessionUsage | undefined, run: SessionUsage): SessionUsage {
  if (!existing) return run;
  return {
    inputTokens: existing.inputTokens + run.inputTokens,
    outputTokens: existing.outputTokens + run.outputTokens,
    cachedTokens: existing.cachedTokens + run.cachedTokens,
    cacheCreationTokens: existing.cacheCreationTokens + run.cacheCreationTokens,
    costUsd: existing.costUsd + run.costUsd,
    turns: [...(existing.turns ?? []), ...run.turns],
  };
}

/**
 * On-disk session persistence.
 * Each session has a unique ID and is stored as <id>.json under the project's
 * session directory. Sessions track full conversation history and metadata.
 */
export const sessionStore = {
  defaultDir(): string {
    return process.env.AURA_SESSION_DIR ?? path.join(process.env.HOME ?? '/tmp', '.aura', 'sessions');
  },

  projectDir(projectRoot: string): string {
    const resolved = path.resolve(projectRoot);
    const safe = resolved.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return path.join(this.defaultDir(), safe);
  },

  generateId(): string {
    return crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
  },

  /**
   * Whether a directory entry is a session file at all. The sessions dir also
   * holds companion artifacts keyed off a session id — the loop's crash-safety
   * `<id>.run.json` and tiered-context's `<id>.factlog.json` — and a legacy
   * `latest.json` pointer. None of them is a session; listing or migrating
   * them as one put "Untitled" ghosts and duplicate threads in every sidebar.
   */
  isSessionFile(f: string): boolean {
    return (
      f.endsWith('.json') &&
      !f.endsWith('.tmp') &&
      !f.endsWith('.run.json') &&
      !f.endsWith('.factlog.json') &&
      path.basename(f, '.json') !== 'latest'
    );
  },

  /** Derive a short title from the first user message. */
  titleFromHistory(history: HistoryMessage[]): string {
    const first = history.find(m => m.role === 'user');
    if (!first) return 'Untitled';
    const text = typeof first.content === 'string' ? first.content : '';
    return text.slice(0, 60).replace(/\n/g, ' ') || 'Untitled';
  },

  async save(filePath: string, history: HistoryMessage[]): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      savedAt: new Date().toISOString(),
      version: 1,
      history,
    };
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  },

  async load(filePath: string): Promise<HistoryMessage[]> {
    if (!fs.existsSync(filePath)) return [];
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as { history?: HistoryMessage[] };
      return Array.isArray(parsed.history) ? parsed.history : [];
    } catch {
      return [];
    }
  },

  async saveSession(projectRoot: string, session: ChatSession): Promise<string> {
    const dir = this.projectDir(projectRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    session.projectRoot = path.resolve(projectRoot);
    const filePath = path.join(dir, `${session.id}.json`);
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
    return filePath;
  },

  loadSessionSync(projectRoot: string, id: string): ChatSession | null {
    const filePath = path.join(this.projectDir(projectRoot), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChatSession> & { savedAt?: string };
      if (!parsed.id) {
        if (path.basename(filePath) === 'latest.json') return null;
        return {
          id,
          title: parsed.history ? this.titleFromHistory(parsed.history) : 'Untitled',
          createdAt: parsed.savedAt || new Date().toISOString(),
          updatedAt: parsed.savedAt || new Date().toISOString(),
          version: 1,
          history: parsed.history || [],
        } as ChatSession;
      }
      return parsed as ChatSession;
    } catch {
      return null;
    }
  },

  async loadSession(projectRoot: string, id: string): Promise<ChatSession | null> {
    const filePath = path.join(this.projectDir(projectRoot), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChatSession> & { savedAt?: string };
      if (!parsed.id) {
        if (path.basename(filePath) === 'latest.json') return null;
        return {
          id,
          title: parsed.history ? this.titleFromHistory(parsed.history) : 'Untitled',
          createdAt: parsed.savedAt || new Date().toISOString(),
          updatedAt: parsed.savedAt || new Date().toISOString(),
          version: 1,
          history: parsed.history || [],
        } as ChatSession;
      }
      return parsed as ChatSession;
    } catch {
      return null;
    }
  },

  async upsertSession(
    projectRoot: string,
    id: string,
    history: HistoryMessage[],
    existingTitle?: string,
    runUsage?: SessionUsage,
  ): Promise<ChatSession> {
    let session = await this.loadSession(projectRoot, id);
    const now = new Date().toISOString();
    if (session) {
      session.history = history;
      session.updatedAt = now;
      if (existingTitle) session.title = existingTitle;
    } else {
      session = {
        id,
        title: existingTitle ?? this.titleFromHistory(history),
        createdAt: now,
        updatedAt: now,
        version: 1,
        history,
      };
    }
    // Additive: undefined runUsage leaves any previously accumulated usage
    // untouched (title-only saves, MoA/Archimedes paths that don't collect it yet).
    if (runUsage) session.usage = mergeSessionUsage(session.usage, runUsage);
    await this.saveSession(projectRoot, session);
    return session;
  },

  listSessions(projectRoot: string): ChatSession[] {
    const dir = this.projectDir(projectRoot);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => this.isSessionFile(f))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          const parsed = JSON.parse(raw) as Partial<ChatSession> & { savedAt?: string };
          // Migrate legacy format (no id/title)
          if (!parsed.id) {
            const id = f.replace('.json', '');
            return {
              id,
              title: parsed.history ? this.titleFromHistory(parsed.history) : 'Untitled',
              createdAt: parsed.savedAt || new Date().toISOString(),
              updatedAt: parsed.savedAt || new Date().toISOString(),
              version: 1,
              history: parsed.history || [],
            } as ChatSession;
          }
          return parsed as ChatSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is ChatSession => s !== null)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  },

  findLatestSession(projectRoot: string): ChatSession | null {
    const sessions = this.listSessions(projectRoot);
    return sessions[0] ?? null;
  },

  async deleteSession(projectRoot: string, id: string): Promise<boolean> {
    const filePath = path.join(this.projectDir(projectRoot), `${id}.json`);
    if (!fs.existsSync(filePath)) return false;
    await fs.promises.unlink(filePath);
    return true;
  },

  listForProject(projectRoot: string): string[] {
    const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const dir = path.join(this.defaultDir(), safe);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  },

  /**
   * Every saved session across every project directory, newest first — the one
   * merged list the TUI (`:sessions`) and the web client both render, so both
   * surfaces see the same thing regardless of which directory each was started
   * in. `project` is the directory slug; `projectRoot` is the real absolute
   * path when the session recorded it (all do, from 2026-09-02), else the slug.
   */
  listAllSessions(): Array<ChatSession & { project: string; projectRoot: string }> {
    const root = this.defaultDir();
    if (!fs.existsSync(root)) return [];
    const out: Array<ChatSession & { project: string; projectRoot: string }> = [];
    for (const project of fs.readdirSync(root)) {
      const dir = path.join(root, project);
      let stat: fs.Stats;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!this.isSessionFile(f)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Partial<ChatSession> & { savedAt?: string };
          const id = parsed.id ?? f.replace(/\.json$/, '');
          out.push({
            id,
            title: parsed.title ?? (parsed.history ? this.titleFromHistory(parsed.history) : 'Untitled'),
            createdAt: parsed.createdAt ?? parsed.savedAt ?? new Date(0).toISOString(),
            updatedAt: parsed.updatedAt ?? parsed.savedAt ?? new Date(0).toISOString(),
            version: parsed.version ?? 1,
            history: parsed.history ?? [],
            usage: parsed.usage,
            projectRoot: parsed.projectRoot ?? project,
            project,
          });
        } catch { /* skip an unparseable file */ }
      }
    }
    return out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  },

  /** Find a session by id in ANY project directory (newest match wins). For
   *  `:resume <id>` / the web opening a session from another project. */
  findSessionAnywhere(id: string): (ChatSession & { project: string; projectRoot: string }) | null {
    return this.listAllSessions().find(s => s.id === id) ?? null;
  },
};

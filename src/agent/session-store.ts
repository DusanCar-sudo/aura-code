import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { HistoryMessage } from '../providers/types.js';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: HistoryMessage[];
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
    const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return path.join(this.defaultDir(), safe);
  },

  generateId(): string {
    return crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
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
    const filePath = path.join(dir, `${session.id}.json`);
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
    return filePath;
  },

  async loadSession(projectRoot: string, id: string): Promise<ChatSession | null> {
    const filePath = path.join(this.projectDir(projectRoot), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw) as ChatSession;
    } catch {
      return null;
    }
  },

  async upsertSession(
    projectRoot: string,
    id: string,
    history: HistoryMessage[],
    existingTitle?: string,
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
    await this.saveSession(projectRoot, session);
    return session;
  },

  listSessions(projectRoot: string): ChatSession[] {
    const dir = this.projectDir(projectRoot);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          const parsed = JSON.parse(raw) as Partial<ChatSession> & { savedAt?: string };
          // Migrate legacy format (no id/title)
          if (!parsed.id) return null;
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
};

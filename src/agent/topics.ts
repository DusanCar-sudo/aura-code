import * as fs from 'fs';
import * as path from 'path';
import { auraPath } from '../util/aura-home.js';

// ─────────────────────────────────────────────────────────────────────────────
// Topic packs — "university" memory.
//
// A topic is a namespace of curated facts about one subject, stored beside the
// rest of memory as ~/.aura/memory/topic-<name>.json so the existing `memory`
// tool (recall, list, and especially search) reaches it with no new plumbing.
//
// Two rules the storage enforces, because they are what separates a useful
// pack from a corrupted one:
//
//  1. Every fact carries provenance — where it came from and when. A fact with
//     no source is an assertion, and it is labelled as one when injected. The
//     failure mode of "educate Aura in anything" is a wrong fact that outranks
//     the model's own (better) knowledge forever; a dated source is the only
//     thing that makes such a fact auditable later.
//  2. Nothing is injected unless a topic is explicitly pinned with `:study`.
//     Packs are retrieved on demand through memory search. Resident topic text
//     in the system prefix is exactly the prompt bloat the trim removed, and it
//     would be paid on every request whether or not the task is about chemistry.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = 'topic-';

export interface TopicFact {
  value: string;
  updated: string;
  /** Where this came from: a URL, a file, a person, or 'asserted' when unknown. */
  source?: string;
  /** 'verified' — checked against the source; 'asserted' — taken on trust. */
  confidence?: 'verified' | 'asserted';
}

type TopicStore = Record<string, TopicFact>;

function memoryDir(): string {
  const dir = auraPath('memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Topic names are used as filenames and as memory namespaces. */
export function normalizeTopic(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function topicPath(topic: string): string {
  return path.join(memoryDir(), `${PREFIX}${normalizeTopic(topic)}.json`);
}

/** The pinned-topics file. Persisted so a study session survives a restart. */
function studyPath(): string {
  return path.join(memoryDir(), '.study.json');
}

export function loadTopic(topic: string): TopicStore {
  try {
    const p = topicPath(topic);
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as TopicStore) : {};
  } catch {
    return {};
  }
}

function saveTopic(topic: string, store: TopicStore): void {
  fs.writeFileSync(topicPath(topic), JSON.stringify(store, null, 2), 'utf8');
}

/** Every topic that has at least one fact, with its fact count. */
export function listTopics(): { topic: string; facts: number }[] {
  try {
    return fs.readdirSync(memoryDir())
      .filter(f => f.startsWith(PREFIX) && f.endsWith('.json'))
      .map(f => {
        const topic = f.slice(PREFIX.length, -5);
        return { topic, facts: Object.keys(loadTopic(topic)).length };
      })
      .filter(t => t.facts > 0)
      .sort((a, b) => a.topic.localeCompare(b.topic));
  } catch {
    return [];
  }
}

export interface LearnInput {
  topic: string;
  key: string;
  value: string;
  source?: string;
  confidence?: 'verified' | 'asserted';
}

/** Add or replace one fact in a topic. Returns the namespace it landed in. */
export function learnFact(f: LearnInput): string {
  const topic = normalizeTopic(f.topic);
  const store = loadTopic(topic);
  store[f.key] = {
    value: f.value,
    updated: new Date().toISOString(),
    source: f.source,
    // No source given means nobody checked it. Say so rather than implying it
    // was verified — an unlabelled fact is indistinguishable from a checked one
    // at read time, which is how a pack rots quietly.
    confidence: f.confidence ?? (f.source ? 'verified' : 'asserted'),
  };
  saveTopic(topic, store);
  return `${PREFIX}${topic}`;
}

export function forgetFact(topic: string, key: string): boolean {
  const store = loadTopic(topic);
  if (!store[key]) return false;
  delete store[key];
  saveTopic(topic, store);
  return true;
}

// ── Pinning ──────────────────────────────────────────────────────────────────

export function pinnedTopics(): string[] {
  try {
    const p = studyPath();
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed?.topics) ? parsed.topics.map(String) : [];
  } catch {
    return [];
  }
}

function savePinned(topics: string[]): void {
  fs.writeFileSync(studyPath(), JSON.stringify({ topics }, null, 2), 'utf8');
}

/** Pin a topic. Returns false when the topic has no facts to pin. */
export function pinTopic(topic: string): boolean {
  const t = normalizeTopic(topic);
  if (Object.keys(loadTopic(t)).length === 0) return false;
  const next = [...new Set([...pinnedTopics(), t])];
  savePinned(next);
  return true;
}

export function unpinTopic(topic: string): void {
  const t = normalizeTopic(topic);
  savePinned(pinnedTopics().filter(x => x !== t));
}

export function unpinAll(): void {
  savePinned([]);
}

// ── Injection ────────────────────────────────────────────────────────────────

/**
 * The block injected into the system prompt for pinned topics, capped so a
 * large pack cannot swallow the prompt. Facts are ordered newest-first (the
 * same reasoning as identitySection in unified-memory.ts: a just-added fact is
 * usually the one the current work needs), and an unverified fact is marked so
 * the model can weigh it against what it already knows instead of deferring to
 * it blindly.
 */
export function formatStudyBlock(maxChars = 2000): string {
  const topics = pinnedTopics();
  if (topics.length === 0) return '';

  const sections: string[] = [];
  let used = 0;

  for (const topic of topics) {
    const store = loadTopic(topic);
    const keys = Object.keys(store).sort((a, b) => {
      const ta = Date.parse(store[a]?.updated ?? '') || 0;
      const tb = Date.parse(store[b]?.updated ?? '') || 0;
      return tb - ta;
    });
    const lines: string[] = [];
    for (const k of keys) {
      const fact = store[k];
      if (!fact?.value) continue;
      const mark = fact.confidence === 'verified' ? '' : ' *(unverified)*';
      const src = fact.source ? ` — source: ${fact.source}` : '';
      const line = `- **${k}**: ${fact.value}${src}${mark}`;
      if (used + line.length > maxChars) continue; // skip, don't stop — a shorter later fact may still fit
      lines.push(line);
      used += line.length;
    }
    if (lines.length) sections.push(`#### ${topic}\n${lines.join('\n')}`);
  }

  if (sections.length === 0) return '';
  return `\n\n## Studied topics (pinned with :study)\nCurated facts, not textbook knowledge. Treat an *(unverified)* line as a claim to check, not as ground truth — prefer what you already know when they conflict, and say so.\n${sections.join('\n\n')}\n`;
}

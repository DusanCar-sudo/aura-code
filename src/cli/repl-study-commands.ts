/**
 * REPL commands for topic packs: :study, :learn, :unlearn.
 *
 * Same reasoning as repl-lesson-commands.ts, one step further. Lessons are
 * written by the gap loop and read back here so a wrong one can be taken out;
 * topics are written deliberately by a person, which makes them *more*
 * dangerous, not less — a hand-entered fact reads as authoritative and gets
 * pinned into the system prompt where it outranks what the model already knows.
 *
 * So every path here is symmetric: whatever you can pin, you can list, see the
 * provenance of, unpin, and delete.
 */

import chalk from 'chalk';
import {
  listTopics, loadTopic, learnFact, forgetFact,
  pinnedTopics, pinTopic, unpinTopic, unpinAll, normalizeTopic,
} from '../agent/topics.js';
import type { Display } from './display.js';
import type { ReplCommandResult } from './repl-session-commands.js';

export interface StudyCommandCtx {
  display: Pick<Display, 'success' | 'warning'>;
  write: (text: string) => void;
}

const DIM = '#8a94a6';
const FAINT = '#4a5568';
const ACCENT = '#cc785c';

/** `:learn <topic> <key> = <value> [@ <source>]` */
const LEARN_RE = /^:learn\s+(\S+)\s+([^=]+?)\s*=\s*(.+)$/s;

export function handleStudyCommand(input: string, c: StudyCommandCtx): ReplCommandResult | null {
  const trimmed = input.trim();

  // ── :study ────────────────────────────────────────────────────────────────
  if (trimmed === ':study' || trimmed === ':topics') {
    const topics = listTopics();
    const pinned = new Set(pinnedTopics());
    if (topics.length === 0) {
      c.write(chalk.hex(DIM)('\n  No topics yet. Add a fact with:\n'));
      c.write(chalk.hex(FAINT)('    :learn chemistry mole = 6.022e23 particles @ IUPAC 2019\n'));
      return { handled: true };
    }
    c.write(chalk.hex(ACCENT).bold('\n  Topics\n'));
    for (const t of topics) {
      const mark = pinned.has(t.topic) ? chalk.hex('#5a9e6e')(' ● pinned') : '';
      c.write(`  ${chalk.hex(DIM)(t.topic.padEnd(24))}${chalk.hex(FAINT)(`${t.facts} fact${t.facts === 1 ? '' : 's'}`)}${mark}`);
    }
    c.write(chalk.hex(FAINT)('\n  :study <topic> to pin it into the prompt · :study off to unpin all\n'));
    return { handled: true };
  }

  if (trimmed === ':study off' || trimmed === ':study none') {
    unpinAll();
    c.display.success('Unpinned all topics. They stay searchable via the memory tool.');
    return { handled: true };
  }

  const off = trimmed.match(/^:study\s+off\s+(\S+)$/);
  if (off) {
    unpinTopic(off[1]);
    c.display.success(`Unpinned "${normalizeTopic(off[1])}".`);
    return { handled: true };
  }

  const pin = trimmed.match(/^:study\s+(\S+)$/);
  if (pin) {
    const topic = normalizeTopic(pin[1]);
    if (!pinTopic(topic)) {
      c.display.warning(`No topic "${topic}" — nothing to pin. Add a fact first: :learn ${topic} <key> = <value>`);
      return { handled: true };
    }
    const n = Object.keys(loadTopic(topic)).length;
    c.display.success(`Pinned "${topic}" (${n} fact${n === 1 ? '' : 's'}). Takes effect on the next session start.`);
    return { handled: true };
  }

  // ── :learn ────────────────────────────────────────────────────────────────
  if (trimmed.startsWith(':learn')) {
    const m = trimmed.match(LEARN_RE);
    if (!m) {
      c.display.warning('Usage: :learn <topic> <key> = <value> [@ <source>]');
      return { handled: true };
    }
    const [, topic, key, rest] = m;
    // A trailing "@ source" is provenance, not part of the value.
    const at = rest.lastIndexOf('@');
    const hasSource = at > 0 && /\s@\s*\S/.test(rest.slice(at - 1));
    const value = (hasSource ? rest.slice(0, at) : rest).trim();
    const source = hasSource ? rest.slice(at + 1).trim() : undefined;

    if (!value) {
      c.display.warning('Nothing to learn — the value is empty.');
      return { handled: true };
    }
    const ns = learnFact({ topic, key: key.trim(), value, source });
    c.display.success(
      source
        ? `Learned "${key.trim()}" into ${ns} (source: ${source}).`
        : `Learned "${key.trim()}" into ${ns} — marked unverified, no source given.`,
    );
    return { handled: true };
  }

  // ── :unlearn ──────────────────────────────────────────────────────────────
  const unlearn = trimmed.match(/^:unlearn\s+(\S+)\s+(.+)$/);
  if (unlearn) {
    const [, topic, key] = unlearn;
    if (forgetFact(topic, key.trim())) {
      c.display.success(`Forgot "${key.trim()}" from ${normalizeTopic(topic)}.`);
    } else {
      c.display.warning(`No fact "${key.trim()}" in ${normalizeTopic(topic)}.`);
    }
    return { handled: true };
  }

  return null;
}

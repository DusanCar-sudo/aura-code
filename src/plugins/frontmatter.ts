/**
 * Minimal YAML frontmatter parser for plugin markdown files.
 *
 * Supports the subset actually used by Claude Code commands/agents/skills:
 * scalar strings (quoted or bare), numbers, booleans, inline arrays
 * ([a, b]), block arrays (- item), and block scalars (key: | / key: >).
 * Nested maps are skipped rather than parsed — no plugin frontmatter field
 * aura consumes is nested. Deliberately dependency-free (aura's code
 * standard: no new deps).
 *
 * Block scalars matter more than they look: a skill whose `description:` is
 * written as `|` over several indented lines used to parse as the literal
 * string "|", because the indented continuation lines hit the skip-nested
 * branch. That is a silent loss — the skill loads, has a description that is
 * one meaningless character, and gets dropped from the routing catalog in
 * project-skills.ts while looking installed everywhere else.
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized);
  if (!match) return { data: {}, body: normalized };

  const data: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);

  let pendingArrayKey: string | null = null;
  // Set while consuming a `key: |` / `key: >` block; every indented line that
  // follows belongs to it rather than to the skip-nested branch below.
  let blockKey: string | null = null;
  let blockFold = false;
  let blockLines: string[] = [];

  const closeBlock = () => {
    if (blockKey === null) return;
    // Folded (>) joins lines into one paragraph; literal (|) keeps the breaks.
    // Both are dedented, since the indentation is YAML syntax, not content.
    const dedented = blockLines.map(l => l.replace(/^\s+/, ''));
    data[blockKey] = (blockFold ? dedented.join(' ') : dedented.join('\n')).trim();
    blockKey = null;
    blockLines = [];
  };

  for (const line of lines) {
    if (blockKey !== null) {
      // A blank line inside a block is content; an unindented one ends it.
      if (!line.trim()) { blockLines.push(''); continue; }
      if (/^\s/.test(line)) { blockLines.push(line); continue; }
      closeBlock();
    }

    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Block-array item under a pending key:  "  - value"
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && pendingArrayKey) {
      (data[pendingArrayKey] as unknown[]).push(scalar(item[1]));
      continue;
    }

    // Indented non-item line = nested structure we don't consume — skip.
    if (/^\s/.test(line)) { pendingArrayKey = null; continue; }

    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) { pendingArrayKey = null; continue; }
    const [, key, rawValue] = kv;

    // Block scalar header: `key: |`, `key: >`, with optional chomp/indent
    // indicators (|-, >2) that only affect trailing newlines we trim anyway.
    const block = /^([|>])[0-9+-]*$/.exec(rawValue.trim());
    if (block) {
      pendingArrayKey = null;
      blockKey = key;
      blockFold = block[1] === '>';
      blockLines = [];
      continue;
    }

    if (rawValue === '') {
      // Either a block array follows, or an empty value.
      data[key] = [];
      pendingArrayKey = key;
      continue;
    }
    pendingArrayKey = null;

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      data[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map(v => scalar(v.trim()))
        .filter(v => v !== '');
      continue;
    }

    data[key] = scalar(rawValue);
  }

  closeBlock();   // a block running to the end of the frontmatter

  // Keys that collected no items and no value: normalize [] → undefined-ish
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v) && v.length === 0) data[k] = '';
  }

  return { data, body: normalized.slice(match[0].length) };
}

function scalar(raw: string): string | number | boolean {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

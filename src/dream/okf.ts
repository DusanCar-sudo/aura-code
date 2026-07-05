import * as fs from 'fs';
import * as path from 'path';
import type { ReconciledBullet } from './reconcile.js';

/**
 * OKF (Open Knowledge Format) v0.1 bundle writer.
 *
 * Takes the reconciled bullets from Aura's dream system and writes them
 * as a portable OKF knowledge bundle under `<projectRoot>/knowledge/`.
 *
 * OKF spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * Why both .reconciled.md AND an OKF bundle?
 *   - `.reconciled.md` is Aura's internal format — compact, fast, injected
 *     into the system prompt for Aura's own use.
 *   - `knowledge/` is the portable output — any other agent, tool, or human
 *     can read it. Cursor, Claude Code, LangChain agents, Obsidian, MkDocs,
 *     or any OKF consumer can consume Aura's accumulated knowledge without
 *     understanding Aura's dream format.
 *
 * The bundle is regenerated on every reconciliation pass. It's a projection,
 * just like .reconciled.md — delete it and the next :dream rebuilds it.
 *
 * Concept types used:
 *   - "lesson"       — from ## Lessons
 *   - "pattern"      — from ## Patterns
 *   - "open-thread"  — from ## Open threads
 *   - "conflict"     — CONFLICT verdicts get their own concepts
 *
 * Directory structure:
 *   knowledge/
 *     index.md           — bundle root index (okf_version: "0.1")
 *     log.md             — reconciliation changelog
 *     lessons/
 *       index.md
 *       <slug>.md
 *     patterns/
 *       index.md
 *       <slug>.md
 *     open-threads/
 *       index.md
 *       <slug>.md
 */

const KNOWLEDGE_DIR = 'knowledge';
const OKF_VERSION = '0.1';

type Section = 'lessons' | 'patterns' | 'openThreads';

const SECTION_DIR: Record<Section, string> = {
  lessons: 'lessons',
  patterns: 'patterns',
  openThreads: 'open-threads',
};

const SECTION_TYPE: Record<Section, string> = {
  lessons: 'lesson',
  patterns: 'pattern',
  openThreads: 'open-thread',
};

const SECTION_LABEL: Record<Section, string> = {
  lessons: 'Lessons',
  patterns: 'Patterns',
  openThreads: 'Open Threads',
};

function slugify(text: string, tag?: string): string {
  const base = tag ? `${tag}-${text}` : text;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'concept';
}

function deduplicateSlug(slug: string, existing: Set<string>): string {
  if (!existing.has(slug)) {
    existing.add(slug);
    return slug;
  }
  let i = 2;
  while (existing.has(`${slug}-${i}`)) i++;
  const unique = `${slug}-${i}`;
  existing.add(unique);
  return unique;
}

function buildFrontmatter(fields: Record<string, string | string[] | undefined>): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      if (val.length > 0) lines.push(`${key}: [${val.map(v => `"${v}"`).join(', ')}]`);
    } else {
      // Quote strings that contain colons or special chars
      const needsQuote = /[:#\[\]{}"']/.test(val) || val.includes('\n');
      lines.push(`${key}: ${needsQuote ? `"${val.replace(/"/g, '\\"')}"` : val}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function buildConceptFile(bullet: ReconciledBullet, totalDreams: number): string {
  const type = bullet.action === 'CONFLICT' ? 'conflict' : SECTION_TYPE[bullet.section];
  const title = bullet.text.slice(0, 120);
  const tags = bullet.tag ? [bullet.tag] : [];
  if (bullet.action !== 'KEEP') tags.push(bullet.action.toLowerCase());
  const latestDate = bullet.sourceDates.length > 0
    ? bullet.sourceDates[bullet.sourceDates.length - 1]
    : new Date().toISOString().slice(0, 10);
  const timestamp = `${latestDate}T00:00:00Z`;

  const frontmatter = buildFrontmatter({
    type,
    title,
    description: bullet.text,
    tags,
    timestamp,
  });

  const bodyLines: string[] = [];
  bodyLines.push(`# ${title}`);
  bodyLines.push('');
  bodyLines.push(bullet.text);
  bodyLines.push('');
  bodyLines.push(`*${bullet.annotation}* · confidence: ${bullet.confidence}`);

  if (bullet.action === 'CONFLICT' && bullet.conflictsWith) {
    bodyLines.push('');
    bodyLines.push('## Opposing claim');
    bodyLines.push('');
    bodyLines.push(`> ${bullet.conflictsWith.text}`);
    bodyLines.push(`> — *${bullet.conflictsWith.date}*`);
  }

  bodyLines.push('');
  bodyLines.push(`Source dreams: ${bullet.sourceDates.join(', ')}`);

  return `${frontmatter}\n\n${bodyLines.join('\n')}\n`;
}

function buildSectionIndex(
  sectionLabel: string,
  concepts: Array<{ slug: string; title: string }>,
): string {
  const lines = [`# ${sectionLabel}`];
  lines.push('');
  if (concepts.length === 0) {
    lines.push('*No concepts in this section yet.*');
  } else {
    for (const c of concepts) {
      lines.push(`* [${c.title}](${c.slug}.md)`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildRootIndex(
  sections: Record<string, Array<{ slug: string; title: string }>>,
  totalDreams: number,
  totalConcepts: number,
): string {
  const frontmatter = buildFrontmatter({ okf_version: OKF_VERSION });
  const lines = [frontmatter, ''];
  lines.push('# Aura Code — Knowledge Bundle');
  lines.push('');
  lines.push(`> OKF v${OKF_VERSION} · ${totalConcepts} concepts from ${totalDreams} dream(s)`);
  lines.push('');
  lines.push('This bundle is generated by [Aura Code](https://github.com/milodule3-debug/aura-code)\'s');
  lines.push('dream reconciliation system. It contains the agent\'s accumulated knowledge about');
  lines.push('this project — lessons learned, patterns observed, and open threads — in the');
  lines.push('[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).');
  lines.push('');
  lines.push('Any OKF-compatible agent, tool, or viewer can consume this bundle.');
  lines.push('');

  for (const [dirName, concepts] of Object.entries(sections)) {
    const label = dirName.charAt(0).toUpperCase() + dirName.slice(1).replace(/-/g, ' ');
    lines.push(`# ${label}`);
    lines.push('');
    if (concepts.length === 0) {
      lines.push('*None yet.*');
    } else {
      for (const c of concepts) {
        lines.push(`* [${c.title}](${dirName}/${c.slug}.md)`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildLog(totalDreams: number, totalConcepts: number, actionCounts: Record<string, number>): string {
  const now = new Date().toISOString().slice(0, 10);
  const stats = Object.entries(actionCounts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  return [
    '# Change Log',
    '',
    `## ${now}`,
    '',
    `Reconciled ${totalDreams} dream(s) into ${totalConcepts} concepts: ${stats}.`,
    '',
    'Generated by Aura Code · dream reconciliation · OKF v0.1.',
    '',
  ].join('\n');
}

/**
 * Write an OKF v0.1 knowledge bundle from reconciled bullets.
 *
 * Called after reconciliation succeeds. Best-effort — if this fails,
 * .reconciled.md is already written and the dream is safe.
 *
 * The bundle directory is wiped and rebuilt each time (it's a projection).
 */
export function writeOkfBundle(
  bullets: ReconciledBullet[],
  totalDreams: number,
  projectRoot: string,
): string {
  const bundleRoot = path.join(projectRoot, KNOWLEDGE_DIR);

  // Clean and recreate
  if (fs.existsSync(bundleRoot)) {
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  }

  const sections: Section[] = ['lessons', 'patterns', 'openThreads'];
  const sectionConcepts: Record<string, Array<{ slug: string; title: string }>> = {};
  const slugSets: Record<string, Set<string>> = {};
  const actionCounts: Record<string, number> = {};

  for (const section of sections) {
    const dirName = SECTION_DIR[section];
    const dirPath = path.join(bundleRoot, dirName);
    fs.mkdirSync(dirPath, { recursive: true });
    sectionConcepts[dirName] = [];
    slugSets[dirName] = new Set();
  }

  // Write concept files
  for (const bullet of bullets) {
    const dirName = SECTION_DIR[bullet.section];
    const dirPath = path.join(bundleRoot, dirName);
    const rawSlug = slugify(bullet.text, bullet.tag);
    const slug = deduplicateSlug(rawSlug, slugSets[dirName]);
    const title = bullet.text.slice(0, 120);

    const content = buildConceptFile(bullet, totalDreams);
    fs.writeFileSync(path.join(dirPath, `${slug}.md`), content);

    sectionConcepts[dirName].push({ slug, title });
    actionCounts[bullet.action] = (actionCounts[bullet.action] ?? 0) + 1;
  }

  // Write section index files
  for (const section of sections) {
    const dirName = SECTION_DIR[section];
    const dirPath = path.join(bundleRoot, dirName);
    const indexContent = buildSectionIndex(SECTION_LABEL[section], sectionConcepts[dirName]);
    fs.writeFileSync(path.join(dirPath, 'index.md'), indexContent);
  }

  // Write root index
  const totalConcepts = bullets.length;
  const rootIndex = buildRootIndex(sectionConcepts, totalDreams, totalConcepts);
  fs.writeFileSync(path.join(bundleRoot, 'index.md'), rootIndex);

  // Write log.md
  const log = buildLog(totalDreams, totalConcepts, actionCounts);
  fs.writeFileSync(path.join(bundleRoot, 'log.md'), log);

  return bundleRoot;
}

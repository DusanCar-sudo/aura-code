import { describe, it, expect } from 'vitest';
import { parseDreamMarkdown } from '../../src/dream/parser.js';

// A realistic fixture mirroring what runDream() actually produces today —
// including the trailing whitespace, blank lines between bullets, and the
// mix of [tagged] and untagged bullets seen in production dreams.
const REAL_DREAM = `# Dream — 2026-06-26

> 69 episodes recalled since beginning · 46 approved · 2 archimedes wins
> Categories: other, research, implementation, review

## Lessons

- [tooling] \`:approve all\` (and variants) is the standard command to batch-approve pending tasks; typos like \`:aprove all\` are common but also accepted.    

- [safety] The safety system can lock the agent (\`SAFETY ON/OFF\`) and requires explicit reset via Telegram or command.

- [bug] The \`:viz\` command referenced an incorrect path — path resolution should be relative to project root.

## Patterns

- File operations are the most common task shape: copying files, moving downloads, editing configs.

- User frequently asks to create usage documentation (\`.md\` files) immediately after building a tool.

## Open threads

- [todo] Finish implementing the kanban board from existing HTML file.

- [todo] Fix the \`HistoryMessage\` type error in \`src/cli/index.ts:1789\`.

## Tomorrow brief

Be ready to continue the kanban board implementation. Also fix the build error in \`src/cli/index.ts\` and deploy the website.
`;

describe('parseDreamMarkdown — real dream file', () => {
  const parsed = parseDreamMarkdown(REAL_DREAM, '2026-06-26');

  it('extracts the date from filename', () => {
    expect(parsed.date).toBe('2026-06-26');
  });

  it('parses three Lessons bullets', () => {
    expect(parsed.lessons).toHaveLength(3);
  });

  it('extracts the [tag] prefix when present', () => {
    expect(parsed.lessons[0].tag).toBe('tooling');
    expect(parsed.lessons[1].tag).toBe('safety');
    expect(parsed.lessons[2].tag).toBe('bug');
  });

  it('keeps bullet text without the [tag] prefix', () => {
    expect(parsed.lessons[0].text).toContain(':approve all');
    expect(parsed.lessons[0].text).not.toContain('[tooling]');
  });

  it('strips trailing whitespace from bullet text', () => {
    for (const b of parsed.lessons) {
      expect(b.text).toBe(b.text.trim());
    }
  });

  it('attaches sourceDate to every bullet', () => {
    const all = [...parsed.lessons, ...parsed.patterns, ...parsed.openThreads];
    for (const b of all) {
      expect(b.sourceDate).toBe('2026-06-26');
    }
  });

  it('parses untagged Patterns bullets without a tag field', () => {
    expect(parsed.patterns).toHaveLength(2);
    expect(parsed.patterns[0].tag).toBeUndefined();
    expect(parsed.patterns[0].text).toContain('File operations');
  });

  it('parses Open threads with [todo] tags', () => {
    expect(parsed.openThreads).toHaveLength(2);
    expect(parsed.openThreads[0].tag).toBe('todo');
    expect(parsed.openThreads[1].tag).toBe('todo');
  });

  it('captures Tomorrow brief as joined prose', () => {
    expect(parsed.tomorrowBrief).toContain('kanban board');
    expect(parsed.tomorrowBrief).toContain('deploy the website');
  });
});

describe('parseDreamMarkdown — edge cases', () => {
  it('returns empty sections for an empty dream', () => {
    const p = parseDreamMarkdown('# Dream — 2026-01-01\n\n', '2026-01-01');
    expect(p.lessons).toEqual([]);
    expect(p.patterns).toEqual([]);
    expect(p.openThreads).toEqual([]);
    expect(p.tomorrowBrief).toBe('');
  });

  it('handles missing sections gracefully', () => {
    const md = `# Dream — 2026-01-02\n\n## Lessons\n\n- [x] Something learned.\n`;
    const p = parseDreamMarkdown(md, '2026-01-02');
    expect(p.lessons).toHaveLength(1);
    expect(p.patterns).toEqual([]);
    expect(p.openThreads).toEqual([]);
    expect(p.tomorrowBrief).toBe('');
  });

  it('accepts asterisk bullets as well as hyphens', () => {
    const md = `# Dream — 2026-01-03\n\n## Lessons\n\n* [tag] Asterisk bullet\n- [tag2] Hyphen bullet\n`;
    const p = parseDreamMarkdown(md, '2026-01-03');
    expect(p.lessons).toHaveLength(2);
    expect(p.lessons[0].tag).toBe('tag');
    expect(p.lessons[1].tag).toBe('tag2');
  });

  it('extracts date from title when filename is unavailable', () => {
    const md = `# Dream — 2026-02-15\n\n## Lessons\n\n- A bullet\n`;
    const p = parseDreamMarkdown(md, '');
    expect(p.date).toBe('2026-02-15');
  });

  it('does not bleed bullets from one section into another', () => {
    const md = [
      '# Dream — 2026-03-01',
      '',
      '## Lessons',
      '- [a] lesson one',
      '',
      '## Patterns',
      '- pattern one',
      '',
      '## Open threads',
      '- [todo] open one',
      '',
      '## Tomorrow brief',
      'Brief text.',
    ].join('\n');
    const p = parseDreamMarkdown(md, '2026-03-01');
    expect(p.lessons.map(b => b.text)).toEqual(['lesson one']);
    expect(p.patterns.map(b => b.text)).toEqual(['pattern one']);
    expect(p.openThreads.map(b => b.text)).toEqual(['open one']);
    expect(p.tomorrowBrief).toBe('Brief text.');
  });

  it('ignores bullets in unknown sections', () => {
    const md = [
      '# Dream — 2026-04-01',
      '## Random Section',
      '- should be ignored',
      '## Lessons',
      '- [a] real lesson',
    ].join('\n');
    const p = parseDreamMarkdown(md, '2026-04-01');
    expect(p.lessons).toHaveLength(1);
    expect(p.lessons[0].text).toBe('real lesson');
  });

  it('handles a bullet that is just [tag] with no body', () => {
    const md = `# Dream — 2026-05-01\n\n## Lessons\n\n- [orphan]\n`;
    const p = parseDreamMarkdown(md, '2026-05-01');
    expect(p.lessons).toHaveLength(1);
    expect(p.lessons[0].text).toBe('[orphan]');
  });
});

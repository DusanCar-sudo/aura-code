import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildRemGraph, type DreamNight } from '../../src/rem/graph.js';
import { renderRemTerminal } from '../../src/rem/render-terminal.js';
import { wrapRemHtml } from '../../src/rem/render-html.js';
import { runRem } from '../../src/rem/index.js';

function night(date: string, over: Partial<DreamNight> = {}): DreamNight {
  return {
    date,
    file: `${date}.md`,
    episodeCount: over.episodeCount ?? 10,
    occurrences: over.occurrences ?? [
      { tag: 'todo', text: 'something to do', section: 'open-threads' },
    ],
    patternCount: over.patternCount ?? 0,
  };
}

describe('renderRemTerminal', () => {
  it('shows a friendly empty-state message with no nights', () => {
    const out = renderRemTerminal(buildRemGraph([]));
    expect(out).toMatch(/No dreams yet/i);
  });

  it('includes the timeline, top-tags ranking, and a recent-detail section', () => {
    const graph = buildRemGraph([
      night('2026-06-22', { occurrences: [{ tag: 'error', text: 'boom', section: 'lessons' }] }),
      night('2026-06-24', {
        occurrences: [
          { tag: 'safety', text: 'blocked task', section: 'lessons' },
          { tag: 'safety', text: 'toggle confusion', section: 'open-threads' },
          { tag: 'todo', text: 'finish telemetry', section: 'open-threads' },
        ],
      }),
    ]);

    const out = renderRemTerminal(graph);
    expect(out).toContain('2026-06-22');
    expect(out).toContain('2026-06-24');
    expect(out).toContain('[safety]');
    expect(out).toContain('[todo]');
    expect(out).toContain('What keeps coming up');
    expect(out).toContain('Recent detail');
    expect(out).toContain('--html');
  });

  it('respects the recentNights option', () => {
    const graph = buildRemGraph([
      night('2026-06-20'), night('2026-06-21'), night('2026-06-22'),
      night('2026-06-23'), night('2026-06-24'), night('2026-06-25'),
    ]);
    const out = renderRemTerminal(graph, { recentNights: 2 });
    expect(out).toContain('Recent detail (last 2)');
  });

  it('truncates long bullet text in the detail view rather than overflowing', () => {
    const longText = 'x'.repeat(200);
    const graph = buildRemGraph([
      night('2026-06-24', { occurrences: [{ tag: 'bug', text: longText, section: 'lessons' }] }),
    ]);
    const out = renderRemTerminal(graph);
    expect(out).toContain('...');
    expect(out).not.toContain(longText); // full untruncated string should not appear
  });
});

describe('wrapRemHtml', () => {
  it('renders a friendly empty state when there are no nights', () => {
    const html = wrapRemHtml(buildRemGraph([]));
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toMatch(/No dreams yet/i);
    expect(html).not.toContain('<svg');
  });

  it('renders an SVG graph and a tag table with escaped content', () => {
    const graph = buildRemGraph([
      night('2026-06-22', { occurrences: [{ tag: 'error', text: 'boom', section: 'lessons' }] }),
      night('2026-06-24', {
        occurrences: [
          { tag: 'safety', text: 'blocked', section: 'lessons' },
          { tag: 'safety', text: 'again', section: 'open-threads' },
        ],
      }),
    ]);

    const html = wrapRemHtml(graph);
    expect(html).toContain('<svg');
    expect(html).toContain('class="rem-graph"');
    expect(html).toContain('2026-06-22');
    expect(html).toContain('2026-06-24');
    expect(html).toContain('[safety]');
    expect(html).toContain('[error]');
    expect(html).toContain('class="tag-table"');
  });

  it('HTML-escapes tag names so a malicious/odd tag cannot break out of attributes', () => {
    const graph = buildRemGraph([
      night('2026-06-24', { occurrences: [{ tag: '"><script>alert(1)</script>', text: 'x', section: 'lessons' }] }),
    ]);
    const html = wrapRemHtml(graph);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('runRem', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rem-run-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns terminal output and writes no file by default', () => {
    const res = runRem({ projectRoot });
    expect(res.terminalOutput).toMatch(/No dreams yet/i);
    expect(res.htmlPath).toBeUndefined();
    expect(fs.existsSync(path.join(projectRoot, 'dreams', 'rem.html'))).toBe(false);
  });

  it('writes dreams/rem.html when writeHtml is true', () => {
    fs.mkdirSync(path.join(projectRoot, 'dreams'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'dreams', '2026-06-24.md'),
      '# Dream — 2026-06-24\n\n> 5 episodes recalled since beginning · 3 approved · 0 archimedes wins\n> Categories: other\n\n## Lessons\n- [tooling] something learned\n\n## Patterns\n- none\n\n## Open threads\n- none\n\n## Tomorrow brief\nKeep going.\n',
    );

    const res = runRem({ projectRoot, writeHtml: true });
    expect(res.htmlPath).toBe(path.join(projectRoot, 'dreams', 'rem.html'));
    expect(fs.existsSync(res.htmlPath!)).toBe(true);
    const html = fs.readFileSync(res.htmlPath!, 'utf8');
    expect(html).toContain('[tooling]');
  });

  it('overwrites rem.html on repeated runs rather than accumulating files', () => {
    runRem({ projectRoot, writeHtml: true });
    const before = fs.readdirSync(path.join(projectRoot, 'dreams'));
    runRem({ projectRoot, writeHtml: true });
    const after = fs.readdirSync(path.join(projectRoot, 'dreams'));
    expect(after).toEqual(before);
  });
});

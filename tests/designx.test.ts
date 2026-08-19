import { describe, it, expect } from 'vitest';
import { parseDesignXArgs, inferTarget, slugifyBrief } from '../src/design/parse.js';
import { routeStyles, findStyle, DESIGN_STYLES, seedFrom } from '../src/design/styles.js';
import { buildScrapePlan } from '../src/design/references.js';
import { buildDesignXPrompt } from '../src/design/prompts.js';

/** A stand-in for a finished artefact: big enough and placeholder-free, so the
 *  finished-artefact check in runDesignX passes. Tests that want the failure
 *  path write a skeleton instead. */
const FAKE_PAGE =
  '<!doctype html><html><head><style>' + ':root{--ink:#111}body{color:var(--ink)}'.repeat(60) +
  '</style></head><body><h1>Moss</h1><p>Real copy.</p></body></html>';

/**
 * :designx has no runtime state and no provider dependency until the loop runs,
 * so everything up to that point — routing, parsing, prompt assembly — is
 * testable directly. That matters more here than for most commands: the whole
 * value of the command is what goes into the prompt, and a silently dropped
 * flag or an empty style list still produces a plausible-looking page.
 */

describe('parseDesignXArgs', () => {
  it('takes an explicit target and keeps the rest as the brief', () => {
    const a = parseDesignXArgs(' deck a pitch for a rice cooker ');
    expect(a.target).toBe('deck');
    expect(a.targetInferred).toBe(false);
    expect(a.brief).toBe('a pitch for a rice cooker');
  });

  it('infers the target from the brief when none is given', () => {
    expect(parseDesignXArgs('a 10 slide presentation about moss').target).toBe('deck');
    expect(parseDesignXArgs('a one page pdf report on rainfall').target).toBe('pdf');
    expect(parseDesignXArgs('landing page for a coffee subscription').target).toBe('web');
  });

  it('defaults to web when the brief says nothing about format', () => {
    const a = parseDesignXArgs('something about bees');
    expect(a.target).toBe('web');
    expect(a.targetInferred).toBe(true);
  });

  it('parses every flag and strips them from the brief', () => {
    const a = parseDesignXArgs('web a shop --wild --style risograph,blueprint --seed 42 --count 3 --no-scrape --out out/x');
    expect(a.daring).toBe('wild');
    expect(a.pinned).toEqual(['risograph', 'blueprint']);
    expect(a.seed).toBe(42);
    expect(a.count).toBe(3);
    expect(a.scrape).toBe(false);
    expect(a.out).toBe('out/x');
    expect(a.brief).toBe('a shop');
  });

  it('clamps --count into the useful range', () => {
    expect(parseDesignXArgs('x --count 99').count).toBe(4);
    expect(parseDesignXArgs('x --count 0').count).toBe(1);
  });

  it('ignores a flag value that is missing or malformed rather than eating the next flag', () => {
    const a = parseDesignXArgs('x --seed --wild');
    expect(a.seed).toBeUndefined();
    expect(a.daring).toBe('wild');
  });

  it('recognises the styles listing form', () => {
    expect(parseDesignXArgs('styles').listStyles).toBe(true);
    expect(parseDesignXArgs('a real brief').listStyles).toBe(false);
  });

  it('leaves unknown dashed tokens in the brief instead of erroring', () => {
    expect(parseDesignXArgs('a page with --- dividers').brief).toBe('a page with --- dividers');
  });
});

describe('inferTarget / slugifyBrief', () => {
  it('lets an explicit deck word beat an incidental web word', () => {
    expect(inferTarget('slides for the landing team, presentation style')).toBe('deck');
  });

  it('produces a filesystem-safe slug and never an empty one', () => {
    expect(slugifyBrief('Rice Cooker: a Pitch!')).toBe('rice-cooker-a-pitch');
    expect(slugifyBrief('!!!')).toBe('design');
  });
});

describe('routeStyles', () => {
  it('only returns styles that survive the target format', () => {
    for (const target of ['web', 'deck', 'pdf'] as const) {
      const picked = routeStyles({ brief: 'a thing', target, daring: 'balanced', count: 3 });
      expect(picked.length).toBeGreaterThan(0);
      for (const s of picked) expect(s.fits).toContain(target);
    }
  });

  it('honours the daring band', () => {
    const classic = routeStyles({ brief: 'a report', target: 'web', daring: 'classic', count: 3 });
    for (const s of classic) expect(s.risk).toBeLessThanOrEqual(2);
    const feral = routeStyles({ brief: 'a party', target: 'web', daring: 'feral', count: 3 });
    for (const s of feral) expect(s.risk).toBeGreaterThanOrEqual(4);
  });

  it('lets cue overlap beat the random tiebreak', () => {
    const picked = routeStyles({ brief: 'a benchmark metrics report', target: 'pdf', daring: 'balanced', count: 1 });
    expect(picked[0].id).toBe('ledger-scientific');
  });

  it('always keeps a pinned style, first, even outside the daring band', () => {
    const picked = routeStyles({
      brief: 'a calm wellness page', target: 'web', daring: 'classic',
      pinned: ['neo-memphis'], count: 2,
    });
    expect(picked[0].id).toBe('neo-memphis');
    expect(picked.length).toBe(2);
  });

  it('ignores an unknown pinned id without dropping the run', () => {
    const picked = routeStyles({ brief: 'x', target: 'web', daring: 'balanced', pinned: ['not-a-style'], count: 2 });
    expect(picked.length).toBe(2);
    expect(picked.every(s => s.id !== 'not-a-style')).toBe(true);
  });

  it('is reproducible for a given seed and varies across seeds', () => {
    const opts = { brief: 'a page', target: 'web' as const, daring: 'balanced' as const, count: 2 };
    const a = routeStyles({ ...opts, seed: 7 }).map(s => s.id);
    expect(routeStyles({ ...opts, seed: 7 }).map(s => s.id)).toEqual(a);
    const seeds = [1, 2, 3, 4, 5].map(n => routeStyles({ ...opts, seed: n }).map(s => s.id).join());
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('never returns duplicates', () => {
    const picked = routeStyles({ brief: 'x', target: 'web', daring: 'balanced', pinned: ['blueprint'], count: 4 });
    expect(new Set(picked.map(s => s.id)).size).toBe(picked.length);
  });
});

describe('the lexicon itself', () => {
  it('has unique ids and a format each style survives', () => {
    expect(new Set(DESIGN_STYLES.map(s => s.id)).size).toBe(DESIGN_STYLES.length);
    for (const s of DESIGN_STYLES) expect(s.fits.length).toBeGreaterThan(0);
  });

  it('covers every daring band for every target, so routing can never come back empty', () => {
    for (const target of ['web', 'deck', 'pdf'] as const) {
      for (const daring of ['classic', 'balanced', 'wild', 'feral'] as const) {
        expect(routeStyles({ brief: 'x', target, daring, count: 1 }).length).toBe(1);
      }
    }
  });

  it('finds styles by id and by name', () => {
    expect(findStyle('blueprint')?.id).toBe('blueprint');
    expect(findStyle('Terminal Gothic')?.id).toBe('terminal-gothic');
    expect(findStyle('nope')).toBeUndefined();
  });

  it('hashes seeds deterministically', () => {
    expect(seedFrom('abc')).toBe(seedFrom('abc'));
    expect(seedFrom('abc')).not.toBe(seedFrom('abd'));
  });
});

describe('buildScrapePlan', () => {
  it('leads with style-specific queries rather than the brief', () => {
    const styles = routeStyles({ brief: 'a shop', target: 'web', daring: 'balanced', seed: 1, count: 2 });
    const plan = buildScrapePlan(styles, 'web', 'a shop');
    expect(plan.queries[0]).toContain(styles[0].name);
    expect(plan.queries.some(q => q.includes('a shop'))).toBe(true);
  });

  it('only seeds sources that apply to the target', () => {
    const styles = routeStyles({ brief: 'a report', target: 'pdf', daring: 'balanced', count: 1 });
    for (const s of buildScrapePlan(styles, 'pdf', 'a report').seeds) {
      expect(s.targets).toContain('pdf');
    }
  });

  it('adds the paged-media query only for pdf', () => {
    const styles = routeStyles({ brief: 'x', target: 'pdf', daring: 'balanced', count: 1 });
    expect(buildScrapePlan(styles, 'pdf', 'x').queries.some(q => q.includes('@page'))).toBe(true);
    const web = routeStyles({ brief: 'x', target: 'web', daring: 'balanced', count: 1 });
    expect(buildScrapePlan(web, 'web', 'x').queries.some(q => q.includes('@page'))).toBe(false);
  });
});

describe('buildDesignXPrompt', () => {
  const styles = routeStyles({ brief: 'a shop', target: 'web', daring: 'wild', seed: 3, count: 2 });

  it('carries the brief, the routed directions and the output directory', () => {
    const p = buildDesignXPrompt({
      brief: 'a shop for hot sauce', target: 'web', daring: 'wild', styles,
      plan: buildScrapePlan(styles, 'web', 'a shop for hot sauce'), outDir: 'design/hot-sauce-web',
    });
    expect(p).toContain('a shop for hot sauce');
    expect(p).toContain('design/hot-sauce-web');
    for (const s of styles) expect(p).toContain(s.name);
    expect(p).toContain('DESIGN.md');
  });

  it('states the target-specific artefact contract', () => {
    const mk = (target: 'web' | 'deck' | 'pdf') => buildDesignXPrompt({
      brief: 'x', target, daring: 'balanced',
      styles: routeStyles({ brief: 'x', target, daring: 'balanced', count: 1 }),
      plan: null, outDir: 'design/x',
    });
    expect(mk('web')).toContain('index.html');
    expect(mk('deck')).toContain('deck.html');
    expect(mk('pdf')).toContain('document.html');
    expect(mk('pdf')).toContain('@page');
  });

  it('includes the research pass only when scraping, and says so when not', () => {
    const withPlan = buildDesignXPrompt({
      brief: 'x', target: 'web', daring: 'balanced', styles,
      plan: buildScrapePlan(styles, 'web', 'x'), outDir: 'design/x',
    });
    expect(withPlan).toContain('RESEARCH PASS');
    expect(withPlan).toContain('web_search');

    const without = buildDesignXPrompt({
      brief: 'x', target: 'web', daring: 'balanced', styles, plan: null, outDir: 'design/x',
    });
    expect(without).not.toContain('RESEARCH PASS');
    expect(without).toContain('--no-scrape');
  });

  it('changes its instruction with the daring dial', () => {
    const classic = buildDesignXPrompt({ brief: 'x', target: 'web', daring: 'classic', styles, plan: null, outDir: 'd' });
    const feral = buildDesignXPrompt({ brief: 'x', target: 'web', daring: 'feral', styles, plan: null, outDir: 'd' });
    expect(classic).toContain('Restraint is the assignment');
    expect(feral).toContain('Go all the way');
    expect(classic).not.toBe(feral);
  });
});

/**
 * runDesignX itself, with the agent loop stubbed: the parts worth pinning are
 * that it creates the output directory before the loop runs (the agent is told
 * to write there, and a missing directory turns into a write_file failure three
 * turns in), and that success is decided by what is on disk rather than by the
 * model's own claim to have written something.
 */
describe('runDesignX', () => {
  it('creates the output dir, passes the built prompt, and reports the files actually on disk', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const pathMod = await import('path');
    const { vi } = await import('vitest');

    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'designx-'));
    const seen: { task?: string; maxTurns?: number } = {};

    vi.resetModules();
    vi.doMock('../src/tools/web-search.js', () => ({
      probeSearchAvailability: async () => ({ available: true, backend: 'Brave' }),
    }));
    vi.doMock('../src/agent/loop.js', () => ({
      runAgentLoop: async (o: any) => {
        seen.task = o.task;
        seen.maxTurns = o.maxTurns;
        // Stand in for the agent's own write_file calls.
        fs.writeFileSync(pathMod.join(root, 'design', 'moss-web', 'index.html'), FAKE_PAGE);
        fs.writeFileSync(pathMod.join(root, 'design', 'moss-web', 'DESIGN.md'), '# why');
        return { success: true, summary: 'built', turns: 4, toolCallCount: 9 };
      },
    }));

    const { runDesignX } = await import('../src/design/designx.js');
    const res = await runDesignX({
      projectRoot: root,
      args: parseDesignXArgs('web moss --wild --seed 5'),
      provider: {} as any,
      context: { root } as any,
      permissions: {} as any,
      display: { warning: () => {} } as any,
    });

    expect(fs.existsSync(res.dir)).toBe(true);
    expect(res.dir).toBe(pathMod.join(root, 'design', 'moss-web'));
    expect(res.files).toEqual(['DESIGN.md', 'index.html']);
    expect(res.success).toBe(true);
    expect(res.styles.length).toBe(2);
    expect(res.searchNote).toBeUndefined();
    expect(seen.task).toContain('moss');
    expect(seen.task).toContain('design/moss-web');
    expect(seen.task).toContain('RESEARCH PASS');
    expect(seen.maxTurns).toBe(60);

    vi.doUnmock('../src/agent/loop.js');
    vi.doUnmock('../src/tools/web-search.js');
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The regression this whole pre-flight exists for: with search blocked, the
   * old path handed the agent a research plan it could not execute, and it
   * spent its turns broadening the query ("AI inference" → "linux" → "hello
   * world") instead of building. Now the plan is dropped before the loop starts.
   */
  it('drops the research pass and warns when search is unavailable', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const pathMod = await import('path');
    const { vi } = await import('vitest');

    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'designx-'));
    const warnings: string[] = [];
    let task = '';

    vi.resetModules();
    vi.doMock('../src/tools/web-search.js', () => ({
      probeSearchAvailability: async () => ({ available: false, reason: 'DuckDuckGo served a bot-check page' }),
    }));
    vi.doMock('../src/agent/loop.js', () => ({
      runAgentLoop: async (o: any) => {
        task = o.task;
        fs.writeFileSync(pathMod.join(root, 'design', 'moss-web', 'index.html'), FAKE_PAGE);
        return { success: true, summary: 'built', turns: 2, toolCallCount: 1 };
      },
    }));

    const { runDesignX } = await import('../src/design/designx.js');
    const res = await runDesignX({
      projectRoot: root,
      args: parseDesignXArgs('web moss'),
      provider: {} as any, context: { root } as any, permissions: {} as any,
      display: { warning: (m: string) => warnings.push(m) } as any,
    });

    expect(res.searchNote).toMatch(/bot-check/);
    expect(warnings.join()).toMatch(/web_search unavailable/);
    expect(task).not.toContain('RESEARCH PASS');
    expect(task).toContain('--no-scrape');
    expect(res.success).toBe(true);

    vi.doUnmock('../src/agent/loop.js');
    vi.doUnmock('../src/tools/web-search.js');
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not probe search at all when --no-scrape was passed', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const pathMod = await import('path');
    const { vi } = await import('vitest');

    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'designx-'));
    let probed = false;

    vi.resetModules();
    vi.doMock('../src/tools/web-search.js', () => ({
      probeSearchAvailability: async () => { probed = true; return { available: true }; },
    }));
    vi.doMock('../src/agent/loop.js', () => ({
      runAgentLoop: async () => {
        fs.writeFileSync(pathMod.join(root, 'design', 'moss-web', 'index.html'), FAKE_PAGE);
        return { success: true, summary: '', turns: 1, toolCallCount: 1 };
      },
    }));

    const { runDesignX } = await import('../src/design/designx.js');
    await runDesignX({
      projectRoot: root,
      args: parseDesignXArgs('web moss --no-scrape'),
      provider: {} as any, context: { root } as any, permissions: {} as any,
      display: { warning: () => {} } as any,
    });
    expect(probed).toBe(false);

    vi.doUnmock('../src/agent/loop.js');
    vi.doUnmock('../src/tools/web-search.js');
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is not a success when the loop reports success but wrote nothing', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const pathMod = await import('path');
    const { vi } = await import('vitest');

    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'designx-'));
    vi.resetModules();
    vi.doMock('../src/tools/web-search.js', () => ({
      probeSearchAvailability: async () => ({ available: true }),
    }));
    vi.doMock('../src/agent/loop.js', () => ({
      runAgentLoop: async () => ({ success: true, summary: 'I designed it!', turns: 1, toolCallCount: 0 }),
    }));

    const { runDesignX } = await import('../src/design/designx.js');
    const res = await runDesignX({
      projectRoot: root,
      args: parseDesignXArgs('web moss --no-scrape'),
      provider: {} as any, context: { root } as any,
      permissions: {} as any, display: { warning: () => {} } as any,
    });
    expect(res.files).toEqual([]);
    expect(res.success).toBe(false);

    vi.doUnmock('../src/agent/loop.js');
    vi.doUnmock('../src/tools/web-search.js');
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('the designx prompt tells the agent what to do when search breaks', () => {
  it('says not to retry with simpler wording', () => {
    const styles = routeStyles({ brief: 'x', target: 'web', daring: 'balanced', count: 2 });
    const p = buildDesignXPrompt({
      brief: 'x', target: 'web', daring: 'balanced', styles,
      plan: buildScrapePlan(styles, 'web', 'x'), outDir: 'd',
    });
    expect(p).toContain('IF SEARCH IS BROKEN');
    expect(p).toMatch(/Do NOT retry with broader or simpler wording/);
  });
});

/**
 * The stub-artefact regression. A real run produced this document.html:
 *
 *   <head><style>/_* INSERT_CSS_HERE *_/</style></head>
 *   <body><!-- INSERT_BODY_HERE --></body>
 *
 * 649 bytes, valid HTML, reported as a success because a file existed. The
 * agent had written a skeleton intending to fill it via follow-up shell calls;
 * those calls hit the rtk bug and died. Whatever the cause, an artefact full of
 * placeholders is not a delivered design.
 */
describe('inspectArtefacts', () => {
  const realPage = '<!doctype html><html><head><style>' + 'body{color:red}'.repeat(200) + '</style></head><body><h1>Real</h1></body></html>';

  it('flags the exact skeleton the failed run produced', async () => {
    const os = await import('os'); const fs = await import('fs'); const pathMod = await import('path');
    const { inspectArtefacts } = await import('../src/design/designx.js');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dx-art-'));
    fs.writeFileSync(pathMod.join(dir, 'document.html'),
      '<!doctype html><head><style>\n/* INSERT_CSS_HERE */\n</style></head><body>\n<!-- INSERT_BODY_HERE -->\n</body></html>');
    const problems = inspectArtefacts(dir, ['document.html']);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0].file).toBe('document.html');
    expect(problems.some(p => /placeholder/i.test(p.problem))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags a markup file that is too small to be a real page', async () => {
    const os = await import('os'); const fs = await import('fs'); const pathMod = await import('path');
    const { inspectArtefacts } = await import('../src/design/designx.js');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dx-art-'));
    fs.writeFileSync(pathMod.join(dir, 'index.html'), '<!doctype html><body><h1>Hi</h1></body>');
    const problems = inspectArtefacts(dir, ['index.html']);
    expect(problems.some(p => /stub/.test(p.problem))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a real page, and does not size-check DESIGN.md', async () => {
    const os = await import('os'); const fs = await import('fs'); const pathMod = await import('path');
    const { inspectArtefacts } = await import('../src/design/designx.js');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dx-art-'));
    fs.writeFileSync(pathMod.join(dir, 'index.html'), realPage);
    fs.writeFileSync(pathMod.join(dir, 'DESIGN.md'), '# Why\nLed with Blueprint.');
    expect(inspectArtefacts(dir, ['DESIGN.md', 'index.html'])).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags lorem ipsum and TODOs, which the prompt forbids', async () => {
    const os = await import('os'); const fs = await import('fs'); const pathMod = await import('path');
    const { inspectArtefacts } = await import('../src/design/designx.js');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dx-art-'));
    fs.writeFileSync(pathMod.join(dir, 'a.html'), realPage.replace('Real', 'Lorem ipsum dolor'));
    fs.writeFileSync(pathMod.join(dir, 'b.html'), realPage.replace('Real', 'TODO: write this'));
    expect(inspectArtefacts(dir, ['a.html', 'b.html']).length).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runDesignX marks a placeholder artefact as failed', () => {
  it('does not report success when the only file written is a skeleton', async () => {
    const os = await import('os'); const fs = await import('fs'); const pathMod = await import('path');
    const { vi } = await import('vitest');
    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'designx-'));

    vi.resetModules();
    vi.doMock('../src/tools/web-search.js', () => ({
      probeSearchAvailability: async () => ({ available: true }),
    }));
    vi.doMock('../src/agent/loop.js', () => ({
      runAgentLoop: async () => {
        fs.writeFileSync(pathMod.join(root, 'design', 'moss-web', 'index.html'),
          '<!doctype html><head><style>/* INSERT_CSS_HERE */</style></head><body></body>');
        return { success: true, summary: 'Designed and built.', turns: 20, toolCallCount: 26 };
      },
    }));

    const { runDesignX } = await import('../src/design/designx.js');
    const res = await runDesignX({
      projectRoot: root, args: parseDesignXArgs('web moss --no-scrape'),
      provider: {} as any, context: { root } as any,
      permissions: {} as any, display: { warning: () => {} } as any,
    });

    expect(res.files).toEqual(['index.html']);
    expect(res.success).toBe(false);          // <- the whole point
    expect(res.problems.length).toBeGreaterThan(0);

    vi.doUnmock('../src/agent/loop.js');
    vi.doUnmock('../src/tools/web-search.js');
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('the designx prompt forbids the skeleton-then-fill strategy', () => {
  it('mandates one complete write_file call', () => {
    const styles = routeStyles({ brief: 'x', target: 'web', daring: 'balanced', count: 2 });
    const p = buildDesignXPrompt({ brief: 'x', target: 'web', daring: 'balanced', styles, plan: null, outDir: 'd' });
    expect(p).toContain('write_file');
    expect(p).toMatch(/ONE call/);
    expect(p).toMatch(/INSERT_CSS_HERE/);
    expect(p).toMatch(/no echo-append, no sed/);
    expect(p).toMatch(/read the file back/i);
  });
});

describe('success is judged on the artefact, not on how the loop exited', () => {
  it('reports success when the artefact is clean but the loop ran out of turns', async () => {
    const os = await import('os'); const fs = await import('fs'); const pathMod = await import('path');
    const { vi } = await import('vitest');
    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'designx-'));
    vi.resetModules();
    vi.doMock('../src/tools/web-search.js', () => ({ probeSearchAvailability: async () => ({ available: true }) }));
    vi.doMock('../src/agent/loop.js', () => ({
      runAgentLoop: async () => {
        fs.writeFileSync(pathMod.join(root, 'design', 'moss-web', 'index.html'), FAKE_PAGE);
        // Turn cap hit — the loop reports failure, but the file is finished.
        return { success: false, summary: 'max turns', turns: 60, toolCallCount: 64 };
      },
    }));
    const { runDesignX } = await import('../src/design/designx.js');
    const res = await runDesignX({
      projectRoot: root, args: parseDesignXArgs('web moss --no-scrape'),
      provider: {} as any, context: { root } as any,
      permissions: {} as any, display: { warning: () => {} } as any,
    });
    expect(res.success).toBe(true);
    expect(res.problems).toEqual([]);
    vi.doUnmock('../src/agent/loop.js'); vi.doUnmock('../src/tools/web-search.js'); vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

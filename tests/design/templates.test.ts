import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { templateCss, templateNames, templateDescription } from '../../src/design/templates/index.js';
import { renderPdf } from '../../src/design/render.js';
import { findChrome } from '../../src/util/chrome.js';

/**
 * Templates are print CSS, so the assertions that matter are about paged
 * output: how many pages come out, and what is on them. A snapshot of the CSS
 * text would pass while the deck gained a trailing blank page.
 */

const haveChrome = findChrome() !== null;
let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tpl-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const page = (tpl: Parameters<typeof templateCss>[0], body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${templateCss(tpl)}</style></head><body>${body}</body></html>`;

describe('the template set', () => {
  it('offers the four artefact kinds, each described', () => {
    expect(templateNames().sort()).toEqual(['deck', 'paper', 'report', 'resume']);
    for (const n of templateNames()) expect(templateDescription(n).length).toBeGreaterThan(10);
  });

  it('refuses an unknown name rather than returning empty CSS', () => {
    // Silent empty CSS would render an unstyled document that still "works".
    expect(() => templateCss('nope' as never)).toThrow(/unknown template/);
  });

  it('forces background printing in every template', () => {
    // Chrome drops backgrounds when printing unless told; a dark artefact
    // otherwise prints as blank white paper.
    for (const n of templateNames()) {
      expect(templateCss(n), n).toMatch(/print-color-adjust:\s*exact/);
    }
  });

  it('protects against the standard paged-media defects', () => {
    for (const n of templateNames()) {
      const css = templateCss(n);
      expect(css, `${n}: stranded headings`).toMatch(/break-after:\s*avoid-page/);
      expect(css, `${n}: split figures/rows`).toMatch(/break-inside:\s*avoid/);
      expect(css, `${n}: orphans`).toMatch(/orphans:/);
    }
  });
});

describe.skipIf(!haveChrome)('paged behaviour', () => {
  it('gives a deck one page per slide and no trailing blank', { timeout: 90_000 }, async () => {
    // break-after:page on every slide leaves an empty final page unless the
    // last one opts out — a defect nobody notices until the deck is presented.
    const slides = ['One', 'Two', 'Three']
      .map(t => `<section class="slide"><h1>${t}</h1><p class="notes">SPEAKER_ONLY</p></section>`).join('');
    const src = path.join(dir, 'deck.html');
    fs.writeFileSync(src, page('deck', slides));
    const r = await renderPdf({ htmlPath: src, output: path.join(dir, 'deck.pdf') });
    expect(r.pages).toBe(3);
  });

  it('keeps speaker notes out of the rendered deck', { timeout: 90_000 }, async () => {
    const out = path.join(dir, 'deck.pdf');
    if (!fs.existsSync(out)) return;
    const text = execFileSync('pdftotext', [out, '-'], { encoding: 'utf8' });
    expect(text).not.toContain('SPEAKER_ONLY');
    expect(text).toContain('One');
  });

  it('renders deck pages at 16:9', { timeout: 90_000 }, async () => {
    const out = path.join(dir, 'deck.pdf');
    if (!fs.existsSync(out)) return;
    const info = execFileSync('pdfinfo', [out], { encoding: 'utf8' });
    const m = info.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
    expect(m).toBeTruthy();
    const ratio = Number(m![1]) / Number(m![2]);
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(1.85);
  });

  it('fits a short résumé on one page', { timeout: 90_000 }, async () => {
    const src = path.join(dir, 'cv.html');
    fs.writeFileSync(src, page('resume',
      '<h1>Name</h1><h2>Experience</h2><div class="entry"><h3>Role</h3><ul><li>Did the thing</li></ul></div>'));
    const r = await renderPdf({ htmlPath: src, output: path.join(dir, 'cv.pdf') });
    expect(r.pages).toBe(1);
    expect(r.overflowing).toBe(0);
  });
});

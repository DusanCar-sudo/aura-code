import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { renderPdf, countPdfPages } from '../../src/design/render.js';
import { findChrome } from '../../src/util/chrome.js';

/**
 * These render real PDFs with real Chrome. A mock would assert that we call
 * page.pdf(), which is not the thing that goes wrong — what goes wrong is a
 * file that is well-formed and empty, or set in the wrong typeface, and only
 * an actual render can show that.
 *
 * Skipped rather than failed when Chrome is absent, so a container without it
 * does not report a broken build.
 */

const haveChrome = findChrome() !== null;
const havePdftotext = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-render-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, html: string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, html);
  return p;
};

const PAGE = (body: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe.skipIf(!haveChrome)('renderPdf', () => {
  it('produces a multi-page PDF with the text intact', { timeout: 90_000 }, async () => {
    const src = write('multi.html', PAGE(
      '<h1>One</h1><p>MARKER_ALPHA</p><div style="break-before:page"><p>MARKER_BETA</p></div>',
      '<style>@page{size:A4;margin:20mm}</style>',
    ));
    const out = path.join(dir, 'multi.pdf');
    const r = await renderPdf({ htmlPath: src, output: out });

    expect(r.pages).toBe(2);
    expect(r.bytes).toBeGreaterThan(1000);
    expect(r.consoleErrors).toEqual([]);
    if (havePdftotext) {
      const text = execFileSync('pdftotext', [out, '-'], { encoding: 'utf8' });
      expect(text).toContain('MARKER_ALPHA');
      expect(text).toContain('MARKER_BETA');
    }
  });

  it('reports elements that overflow the page width', { timeout: 90_000 }, async () => {
    // Invisible in a page count, and the reason a printed table loses its last
    // column — so it has to be measured, not eyeballed.
    const src = write('wide.html', PAGE('<div style="width:3000px">too wide</div>'));
    const r = await renderPdf({ htmlPath: src, output: path.join(dir, 'wide.pdf') });
    expect(r.overflowing).toBeGreaterThan(0);
  });

  it('does not report overflow for a page that fits', { timeout: 90_000 }, async () => {
    const src = write('fits.html', PAGE('<p>ordinary paragraph</p>'));
    const r = await renderPdf({ htmlPath: src, output: path.join(dir, 'fits.pdf') });
    expect(r.overflowing).toBe(0);
  });

  it('reports a webfont as loaded, so a silent Times fallback is visible', { timeout: 90_000 }, async () => {
    // The failure this catches: networkidle0 means the font FILE arrived, not
    // that it was applied. Print in between and every glyph is Times, with
    // nothing in the output saying so.
    const font = findLocalFont();
    if (!font) return;
    const src = write('font.html', PAGE('<p>probe</p>',
      `<style>@font-face{font-family:'AuraProbe';src:url('file://${font}') format('truetype')}`
      + `body{font-family:'AuraProbe',serif}</style>`));
    const r = await renderPdf({ htmlPath: src, output: path.join(dir, 'font.pdf') });
    expect(r.fontsLoaded).toContain('AuraProbe');
  });

  it('surfaces a page error instead of silently printing blank', { timeout: 90_000 }, async () => {
    const src = write('boom.html', PAGE('<script>throw new Error("BOOM_MARKER")</script>'));
    const r = await renderPdf({ htmlPath: src, output: path.join(dir, 'boom.pdf') });
    expect(r.consoleErrors.join(' ')).toContain('BOOM_MARKER');
  });

  it('refuses a missing input rather than writing an empty file', async () => {
    await expect(renderPdf({ htmlPath: path.join(dir, 'nope.html'), output: path.join(dir, 'nope.pdf') }))
      .rejects.toThrow(/not found/i);
  });
});

describe('countPdfPages', () => {
  it.skipIf(!haveChrome)('counts pages without asking Chrome', { timeout: 90_000 }, async () => {
    // Reads the artefact on disk, which is the thing being verified. It also
    // must not count the /Pages tree node — the classic off-by-one that makes
    // every document report one page too many.
    const src = write('three.html', PAGE(
      '<p>a</p><div style="break-before:page"><p>b</p></div><div style="break-before:page"><p>c</p></div>',
    ));
    const out = path.join(dir, 'three.pdf');
    await renderPdf({ htmlPath: src, output: out });
    expect(countPdfPages(out)).toBe(3);
  });

  it('returns 0 for a file that is not a PDF', () => {
    const p = write('not.pdf', 'this is not a pdf at all');
    expect(countPdfPages(p)).toBe(0);
  });
});

function findLocalFont(): string | null {
  for (const root of ['/usr/share/fonts', '/System/Library/Fonts']) {
    try {
      const found = execFileSync('find', [root, '-name', '*.ttf'], { encoding: 'utf8', timeout: 10_000 })
        .split('\n').filter(Boolean);
      if (found.length) return found[0];
    } catch { /* keep looking */ }
  }
  return null;
}

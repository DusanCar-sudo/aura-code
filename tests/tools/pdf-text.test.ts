import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderPdf } from '../../src/design/render.js';
import { extractPdfText, hasPdftotext, pdfPageCount } from '../../src/tools/pdf-text.js';

/**
 * Reading a PDF must not depend on the user having installed poppler.
 *
 * It used to: `read_file` on a PDF, and the content check that catches a blank
 * render, both shelled out to pdftotext and apologised when it was missing. So
 * the feature simply did not work for anyone who ran `npm install -g
 * aura-code` on a machine without it — and Aura's own CI was one, which is how
 * five tests came to be red for a missing apt package.
 *
 * poppler is still preferred where present, because `-layout` handles columns
 * better than anything bundled. These check that both paths work, since a
 * fallback nobody exercises is a fallback nobody can rely on.
 */

let dir: string;
let pdf: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pdftext-'));
  const html = path.join(dir, 'doc.html');
  fs.writeFileSync(html, '<!doctype html><html><body>'
    + '<h1>Extractable Heading</h1>'
    + '<p>Enough prose here to be clearly extractable text in the rendered PDF.</p>'
    + '</body></html>');
  pdf = path.join(dir, 'doc.pdf');
  await renderPdf({ htmlPath: html, output: pdf });
}, 90_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Run something with poppler hidden, to exercise the bundled parser. */
async function withoutPoppler<T>(fn: () => Promise<T>): Promise<T> {
  const realPath = process.env.PATH;
  // Keep node reachable but drop everything that could supply pdftotext.
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-nopoppler-'));
  fs.symlinkSync(process.execPath, path.join(shim, 'node'));
  process.env.PATH = shim;
  try {
    return await fn();
  } finally {
    process.env.PATH = realPath;
    try { fs.rmSync(shim, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('extracting a PDF', () => {
  it('reads the text back out of a real render', { timeout: 60_000 }, async () => {
    const { text } = await extractPdfText(pdf);
    expect(text).toContain('Extractable Heading');
    expect(text).toContain('extractable text');
  });

  it('counts pages', { timeout: 60_000 }, async () => {
    expect(await pdfPageCount(pdf)).toBe(1);
  });

  it('works with no poppler installed at all', { timeout: 90_000 }, async () => {
    // The case that matters: a machine where someone npm-installed Aura.
    await withoutPoppler(async () => {
      expect(hasPdftotext()).toBe(false);
      const { text, via, pages } = await extractPdfText(pdf);
      expect(via).toBe('pdfjs');
      expect(text).toContain('Extractable Heading');
      // The bundled parser reports the page count too, so a missing pdfinfo
      // does not cost the count as well as the text.
      expect(pages).toBe(1);
    });
  });

  it('counts pages with no poppler either', { timeout: 90_000 }, async () => {
    await withoutPoppler(async () => {
      expect(await pdfPageCount(pdf)).toBe(1);
    });
  });

  it('prefers poppler when it is there', { timeout: 60_000 }, async () => {
    // Not a style preference: -layout keeps columns apart, and without it a
    // two-column CV interleaves its sidebar into the body line by line.
    if (!hasPdftotext()) return;
    expect((await extractPdfText(pdf)).via).toBe('pdftotext');
  });

  it('reports a page count of 0 for something that is not a PDF', { timeout: 60_000 }, async () => {
    const notPdf = path.join(dir, 'not.pdf');
    fs.writeFileSync(notPdf, 'this is not a PDF at all');
    expect(await pdfPageCount(notPdf)).toBe(0);
  });
});

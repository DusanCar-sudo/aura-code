/**
 * HTML → PDF / PNG.
 *
 * The through-line of Aura's publishing work is that HTML is the authoring
 * format and everything else is a render target: the agent already writes
 * strong HTML/CSS, Chrome is already a dependency, and CSS paged media covers
 * résumés, reports, papers and decks with one skill rather than four.
 *
 * Until now this existed only as a hopeful sentence in a prompt
 * (design/prompts.ts: "try to render document.pdf with headless Chrome") —
 * page.pdf() was called nowhere in the codebase.
 *
 * Two failure modes drive the design, both of which produce a file that looks
 * fine and is wrong:
 *
 *   1. **Fonts.** Artefacts may use Google Fonts. Chrome will happily print
 *      before a webfont finishes loading, silently substituting Times. The PDF
 *      is the right length with the right words and the wrong typography, and
 *      nothing in the output says so — hence the explicit document.fonts.ready
 *      await, and the reported font list so a caller can check.
 *   2. **Blank output.** A page that throws during load still prints, as empty
 *      pages. Page count alone cannot tell that apart from a real document,
 *      which is why extractability is measured rather than assumed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { findChrome, CHROME_MISSING_MESSAGE } from '../util/chrome.js';

export type PageFormat = 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';

export interface RenderOptions {
  /** Absolute path to the HTML file to render. */
  htmlPath: string;
  /** Absolute path to write. */
  output: string;
  format?: PageFormat;
  landscape?: boolean;
  /** CSS lengths, e.g. '18mm'. Ignored when the document sets @page margins
   *  and preferCSSPageSize applies. */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /** Footer with "n / total". Off by default: a one-page résumé or a slide
   *  deck is worse with page numbers, and the caller knows which it has. */
  pageNumbers?: boolean;
  /** PNG only. */
  width?: number;
  height?: number;
  fullPage?: boolean;
  scale?: number;
  timeoutMs?: number;
}

export interface RenderResult {
  output: string;
  bytes: number;
  /** PDF only, from the rendered document. */
  pages?: number;
  /** Font families the page actually loaded, so a caller can see a webfont
   *  that silently fell back. */
  fontsLoaded: string[];
  /** Console errors during load. A page that threw still prints — blank. */
  consoleErrors: string[];
  /** Elements wider than the page box: the cause of clipped right edges,
   *  which is invisible in a page count. */
  overflowing: number;
}

const DEFAULT_TIMEOUT = 45_000;

/** Chrome flags that matter for deterministic paged output.
 *  --font-render-hinting=none keeps text metrics identical between the screen
 *  render and the PDF; without it the two disagree just enough to move line
 *  breaks, so what was verified on screen is not what prints. */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--font-render-hinting=none',
];

export async function renderPdf(opts: RenderOptions): Promise<RenderResult> {
  return withPage(opts, async (page) => {
    const pdfOpts: Record<string, unknown> = {
      path: opts.output,
      format: opts.format ?? 'A4',
      landscape: opts.landscape ?? false,
      printBackground: true,
      // The document's own @page rules win over `format` when it has them.
      // A deck declaring 16:9 slides must not be forced onto A4.
      preferCSSPageSize: true,
      margin: opts.margin ?? { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
    };
    if (opts.pageNumbers) {
      pdfOpts.displayHeaderFooter = true;
      pdfOpts.headerTemplate = '<div></div>';
      pdfOpts.footerTemplate =
        '<div style="width:100%;font-size:8px;color:#888;text-align:center;'
        + 'font-family:system-ui,sans-serif;padding-top:6px">'
        + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';
    }
    await page.pdf(pdfOpts);
  });
}

export async function renderPng(opts: RenderOptions): Promise<RenderResult> {
  return withPage(opts, async (page) => {
    await page.screenshot({
      path: opts.output,
      type: 'png',
      fullPage: opts.fullPage ?? true,
      ...(opts.scale && opts.scale !== 1 ? {} : {}),
    });
  });
}

/** Load the page, run `emit`, and measure what actually happened. */
async function withPage(
  opts: RenderOptions,
  emit: (page: import('puppeteer-core').Page) => Promise<void>,
): Promise<RenderResult> {
  const abs = path.resolve(opts.htmlPath);
  if (!fs.existsSync(abs)) throw new Error(`HTML not found: ${abs}`);

  const chrome = findChrome();
  if (!chrome) throw new Error(CHROME_MISSING_MESSAGE);

  const outDir = path.dirname(path.resolve(opts.output));
  fs.mkdirSync(outDir, { recursive: true });

  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: CHROME_ARGS,
  });

  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });

    await page.setViewport({
      width: opts.width ?? 1240,
      height: opts.height ?? 1754,        // A4 at ~150dpi; only affects PNG
      deviceScaleFactor: opts.scale ?? 2, // 2x so raster output is not soft
    });

    await page.goto(`file://${abs}`, {
      waitUntil: 'networkidle0',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    });

    // networkidle0 means the font FILE arrived, not that the browser has
    // applied it. Printing between those two moments yields a document set in
    // Times that is otherwise perfect. Bounded, because a font that never
    // resolves must not hang the render.
    await Promise.race([
      page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);

    // Media type must be print for @page and print-only rules to apply. Set
    // AFTER load so any layout JS ran against the screen media it expects.
    await page.emulateMediaType('print');

    const fontsLoaded = await page.evaluate(() => {
      const seen = new Set<string>();
      const d = document as unknown as { fonts: Iterable<{ family: string; status: string }> };
      for (const f of d.fonts) if (f.status === 'loaded') seen.add(f.family);
      return [...seen];
    });

    const overflowing = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth + 1;
      let n = 0;
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.right > limit) n++;
      }
      return n;
    });

    await emit(page);

    const bytes = fs.existsSync(opts.output) ? fs.statSync(opts.output).size : 0;
    if (bytes === 0) throw new Error(`render produced no output at ${opts.output}`);

    return {
      output: opts.output,
      bytes,
      pages: opts.output.endsWith('.pdf') ? countPdfPages(opts.output) : undefined,
      fontsLoaded,
      consoleErrors,
      overflowing,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Page count straight from the PDF's own structure.
 *
 * Reading the file rather than asking Chrome is deliberate: this is the check
 * that the artefact on disk is what was intended, so it has to look at the
 * artefact. Counts /Type /Page objects while excluding /Pages (the tree node),
 * which is the standard trap — a naive match reports one extra on every file.
 */
export function countPdfPages(pdfPath: string): number {
  const buf = fs.readFileSync(pdfPath);
  const text = buf.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  if (matches && matches.length > 0) return matches.length;
  // Linearised or object-stream PDFs may hide those objects; /Count in the
  // page tree is the fallback.
  const count = text.match(/\/Count\s+(\d+)/);
  return count ? parseInt(count[1], 10) : 0;
}

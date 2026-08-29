/**
 * Getting the text back out of a PDF.
 *
 * Two paths, in this order:
 *
 *   1. poppler's `pdftotext -layout`, when it is installed. `-layout` preserves
 *      columns, and without it a two-column CV interleaves the sidebar into the
 *      body line by line — text that reads as corrupted rather than as a
 *      document. Nothing in a pure-JS extractor reproduces that as well.
 *
 *   2. a bundled pdf.js, when it is not.
 *
 * The fallback is the point. `read_file` on a PDF, and the content check that
 * catches a blank render, both used to depend on a binary that is simply absent
 * on a machine where somebody ran `npm install -g aura-code` — so the feature
 * degraded to an apology naming an apt package. Aura's own CI had exactly this
 * failure: five tests red because the runner had no poppler. A tool that only
 * works when the user happens to have installed something else is not a
 * feature, it is a prerequisite in disguise.
 *
 * poppler stays preferred rather than being dropped, because its layout
 * handling is genuinely better and most Linux desktops already have it. The
 * fallback is what makes the tool work everywhere; the fast path is what makes
 * it work *well* where it can.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';

export interface PdfText {
  text: string;
  /** Page count, when the extractor could determine one. */
  pages?: number;
  /** Which path produced this — surfaced so output can say so honestly. */
  via: 'pdftotext' | 'pdfjs';
}

/** True when poppler's pdftotext is callable. */
export function hasPdftotext(): boolean {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** poppler's extraction, or null when the binary is missing. */
function viaPoppler(file: string, layout: boolean): string | null {
  try {
    const args = layout ? ['-layout', file, '-'] : [file, '-'];
    return execFileSync('pdftotext', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (e) {
    // ENOENT means "not installed", which is the case the fallback exists for.
    // Anything else is a real failure on a real file and must not be masked by
    // silently producing worse output from the other path.
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * pdf.js, bundled.
 *
 * Loaded with a dynamic import because unpdf is ESM and this package is
 * CommonJS, and imported lazily so the cost lands only on the first PDF —
 * nothing else in a CLI startup should pay for a PDF parser.
 */
async function viaPdfjs(file: string): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const { text, totalPages } = await extractText(doc, { mergePages: true });
  return { text: Array.isArray(text) ? text.join('\n') : text, pages: totalPages };
}

/**
 * A PDF's text, however we can get it.
 *
 * `layout` asks poppler to preserve columns; it has no effect on the fallback,
 * which reconstructs lines from the text items' own end-of-line flags.
 */
export async function extractPdfText(file: string, layout = true): Promise<PdfText> {
  const popplerText = viaPoppler(file, layout);
  if (popplerText !== null) return { text: popplerText, via: 'pdftotext' };
  const { text, pages } = await viaPdfjs(file);
  return { text, pages, via: 'pdfjs' };
}

/**
 * How many pages a PDF has.
 *
 * pdfinfo first, then pdf.js. Returns 0 when neither can say, which callers
 * already treat as "unknown" rather than as "empty".
 */
export async function pdfPageCount(file: string): Promise<number> {
  try {
    const out = execFileSync('pdfinfo', [file], { encoding: 'utf8', timeout: 15_000 });
    const match = /^Pages:\s+(\d+)/m.exec(out);
    if (match) return Number.parseInt(match[1], 10);
  } catch { /* fall through to the bundled parser */ }
  try {
    return (await viaPdfjs(file)).pages;
  } catch {
    return 0;
  }
}

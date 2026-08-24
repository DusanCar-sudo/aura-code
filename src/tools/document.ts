/**
 * `document` — turn HTML into the things a company actually ships.
 *
 * Shaped like browser.ts (one action enum) because it is the same kind of
 * surface. The premise is that HTML is the authoring format and PDF/PNG are
 * render targets: the agent already writes strong HTML/CSS, so covering
 * résumés, reports, papers and decks needs one skill rather than four
 * generators.
 *
 * `inspect` exists because of a failure this codebase keeps producing: an
 * operation that reports success while doing nothing. A PDF that printed
 * blank, or fell back to Times because a webfont had not applied, is a
 * well-formed file of the right length with nothing visibly wrong — the same
 * shape as `Binary file:` for a readable PDF, or a loop returning success
 * after zero tool calls. So verification is an action here, not a footnote,
 * and to_pdf reports the same evidence without being asked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { ToolDefinition } from '../providers/types.js';
import { renderPdf, renderPng, countPdfPages, type PageFormat } from '../design/render.js';
import { resolveInRoot, PathJailError } from '../safety/path-jail.js';
import { templateCss, templateNames, templateDescription, type TemplateName } from '../design/templates/index.js';

export const DOCUMENT_DEFINITION: ToolDefinition = {
  name: 'document',
  description:
    'Render an HTML file to PDF or PNG, or inspect a rendered PDF. '
    + 'Actions: to_pdf (print-quality PDF via headless Chrome), to_png (raster, for '
    + 'infographics and previews), inspect (page count, extractable text, fonts), '
    + 'template (house print CSS for resume | report | paper | deck — paste into a <style> '
    + 'block, then write your own markup around it). '
    + 'Use for résumés, reports, papers, decks, and any printable deliverable: write the '
    + 'HTML with write_file, then render it. Always inspect the result — a PDF can print '
    + 'blank or in fallback fonts and still look like a valid file.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'to_pdf | to_png | inspect | template' },
      name:   { type: 'string', description: 'template: resume | report | paper | deck' },
      path:   { type: 'string', description: 'Input HTML file (to_pdf/to_png), or the PDF to inspect' },
      output: { type: 'string', description: 'Output file path. Defaults to the input name with .pdf/.png' },
      format: { type: 'string', description: 'Page size: A4 (default), Letter, Legal, A3, A5' },
      landscape: { type: 'boolean', description: 'Landscape orientation (default false)' },
      margin: { type: 'string', description: 'Uniform page margin as a CSS length, e.g. "18mm". Ignored if the document sets @page margins.' },
      page_numbers: { type: 'boolean', description: 'Footer with "n / total" (default false)' },
      full_page: { type: 'boolean', description: 'to_png: capture the whole scrollable page (default true)' },
      width:  { type: 'number', description: 'to_png: viewport width in px (default 1240)' },
      height: { type: 'number', description: 'to_png: viewport height in px (default 1754)' },
    },
    required: ['action'],
  },
};

export interface DocumentInput {
  action: string;
  name?: string;
  path?: string;
  output?: string;
  format?: string;
  landscape?: boolean;
  margin?: string;
  page_numbers?: boolean;
  full_page?: boolean;
  width?: number;
  height?: number;
}

const FORMATS: PageFormat[] = ['A4', 'Letter', 'Legal', 'A3', 'A5'];

export async function documentTool(input: DocumentInput, cwd: string): Promise<string> {
  const action = String(input.action ?? '').toLowerCase();

  // Before the path check: a template is CSS, not a file on disk.
  if (action === 'template') return template(input.name);

  if (!input.path) return 'Error: document needs a path.';

  let src: string;
  try { src = resolveInRoot(cwd, input.path); }
  catch (e) { if (e instanceof PathJailError) return `Error: ${e.message}`; throw e; }
  if (!fs.existsSync(src)) return `Error: file not found: ${input.path}`;

  try {
    switch (action) {
      case 'to_pdf':   return await toPdf(input, cwd, src);
      case 'to_png':   return await toPng(input, cwd, src);
      case 'inspect':  return inspect(src, input.path);
      default:
        return `Error: unknown document action "${input.action}". Use to_pdf, to_png, inspect or template.`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toPdf(input: DocumentInput, cwd: string, src: string): Promise<string> {
  const output = outPath(input, cwd, src, '.pdf');
  const format = FORMATS.find(f => f.toLowerCase() === String(input.format ?? '').toLowerCase());
  if (input.format && !format) {
    return `Error: unknown format "${input.format}". Use one of: ${FORMATS.join(', ')}.`;
  }

  const r = await renderPdf({
    htmlPath: src,
    output,
    format: format ?? 'A4',
    landscape: input.landscape ?? false,
    pageNumbers: input.page_numbers ?? false,
    ...(input.margin
      ? { margin: { top: input.margin, right: input.margin, bottom: input.margin, left: input.margin } }
      : {}),
  });

  const rel = path.relative(cwd, output) || path.basename(output);
  const lines = [
    `Rendered ${rel} — ${r.pages} page(s), ${kb(r.bytes)}.`,
    verdict(output, r.pages ?? 0),
  ];
  // Reported unprompted: both are silent failures, so a caller that did not
  // think to ask is exactly the caller who needs to know.
  if (r.fontsLoaded.length > 0) lines.push(`Webfonts applied: ${r.fontsLoaded.join(', ')}.`);
  if (r.overflowing > 0) {
    lines.push(`WARNING: ${r.overflowing} element(s) extend past the page width — `
      + 'their right edge will be clipped in print. Usually a fixed width or a wide table.');
  }
  if (r.consoleErrors.length > 0) {
    lines.push(`Page errors during render (content may be missing): ${r.consoleErrors.slice(0, 3).join(' | ')}`);
  }
  return lines.join('\n');
}

async function toPng(input: DocumentInput, cwd: string, src: string): Promise<string> {
  const output = outPath(input, cwd, src, '.png');
  const r = await renderPng({
    htmlPath: src,
    output,
    fullPage: input.full_page ?? true,
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
  });
  const rel = path.relative(cwd, output) || path.basename(output);
  const warn = r.overflowing > 0 ? `\nWARNING: ${r.overflowing} element(s) overflow the viewport width.` : '';
  return `Rendered ${rel} — ${kb(r.bytes)}.${warn}`;
}

/**
 * Verify a rendered PDF is a document rather than a well-formed blank.
 * Uses pdftotext, already relied on by read_file, so nothing new is required.
 */
function inspect(src: string, shown: string): string {
  if (!src.toLowerCase().endsWith('.pdf')) {
    return `Error: inspect works on PDFs; ${shown} is not one.`;
  }
  const pages = countPdfPages(src);
  const bytes = fs.statSync(src).size;

  let text = '';
  try {
    text = execFileSync('pdftotext', [src, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  } catch {
    return `${shown}: ${pages} page(s), ${kb(bytes)}. Could not extract text (pdftotext missing?) — `
      + 'install poppler-utils to verify the content is real.';
  }

  const chars = text.replace(/\s+/g, '').length;
  const lines = [`${shown}: ${pages} page(s), ${kb(bytes)}, ${chars.toLocaleString()} characters of text.`];
  lines.push(verdict(src, pages, chars));

  let fonts: string[] = [];
  try {
    const out = execFileSync('pdffonts', [src], { encoding: 'utf8', timeout: 15_000 });
    fonts = out.split('\n').slice(2)
      .map(l => l.trim().split(/\s+/)[0]).filter(Boolean)
      .map(n => n.replace(/^[A-Z]{6}\+/, ''));      // strip subset tags
    if (fonts.length) lines.push(`Fonts embedded: ${[...new Set(fonts)].join(', ')}.`);
  } catch { /* pdffonts is optional */ }

  return lines.join('\n');
}

/** The judgement a page count alone cannot make. */
function verdict(pdfPath: string, pages: number, knownChars?: number): string {
  if (pages === 0) return 'PROBLEM: no pages — the render failed. Do not ship this.';
  let chars = knownChars;
  if (chars === undefined) {
    try {
      chars = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
        .replace(/\s+/g, '').length;
    } catch { return 'Content not verified (pdftotext unavailable).'; }
  }
  // A page of real prose is hundreds of characters. This threshold catches the
  // case that matters — a document that printed as empty pages — without
  // flagging a legitimately sparse title card.
  if (chars < 20) {
    return 'PROBLEM: the PDF has pages but almost no extractable text. It likely printed '
      + 'blank (a script error, or content that never loaded). Check the HTML in a browser.';
  }
  return `Content verified: text is present and extractable (${Math.round(chars / pages)} chars/page).`;
}

/**
 * Hand back a house stylesheet. Returned as CSS rather than written to a file
 * so the agent composes one self-contained document — an external stylesheet
 * is one more thing to lose when the HTML is moved or emailed.
 */
function template(name?: string): string {
  const names = templateNames();
  const chosen = names.find(n => n === String(name ?? '').toLowerCase());
  if (!chosen) {
    const list = names.map(n => `  ${n} — ${templateDescription(n)}`).join('\n');
    return name
      ? `Error: unknown template "${name}". Available:\n${list}`
      : `Available templates:\n${list}\n\nCall again with name=<one of these>.`;
  }
  return [
    `/* Aura house template: ${chosen} — ${templateDescription(chosen as TemplateName)} */`,
    `/* Paste inside <style> in your HTML, then write your own markup. */`,
    templateCss(chosen as TemplateName),
  ].join('\n');
}

function outPath(input: DocumentInput, cwd: string, src: string, ext: string): string {
  if (input.output) {
    try { return resolveInRoot(cwd, input.output); }
    catch (e) { if (e instanceof PathJailError) throw new Error(e.message); throw e; }
  }
  return src.replace(/\.[^.]+$/, '') + ext;
}

const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

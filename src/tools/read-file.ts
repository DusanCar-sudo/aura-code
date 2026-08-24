import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { BINARY_EXTENSIONS } from '../config/defaults.js';
import { resolveInRoot, PathJailError } from '../safety/path-jail.js';

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export function readFile(input: ReadFileInput, cwd: string): string {
  let filePath: string;
  try { filePath = resolveInRoot(cwd, input.path); }
  catch (e) { if (e instanceof PathJailError) return `Error: ${e.message}`; throw e; }

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${input.path}`;
  }

  const ext = path.extname(filePath).toLowerCase();

  // PDFs read as their text, not as "Binary file: 254.7 KB". A CV, an invoice
  // or a spec handed to the agent is a document, and reporting its size is a
  // refusal dressed as an answer — the model's only recourse was to know that
  // pdftotext exists and shell out to it, which it mostly does not.
  if (ext === '.pdf') return readPdf(filePath, input);

  if (BINARY_EXTENSIONS.includes(ext)) {
    const stat = fs.statSync(filePath);
    return `Binary file: ${input.path} (${(stat.size / 1024).toFixed(1)} KB, type: ${ext})`;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return `Error reading file: ${String(e)}`;
  }

  const lines = content.split('\n');
  const total = lines.length;

  if (input.start_line !== undefined || input.end_line !== undefined) {
    const start = Math.max(1, input.start_line ?? 1) - 1;
    const end = Math.min(total, input.end_line ?? total);
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    return `${input.path} (lines ${start + 1}–${end} of ${total}):\n\n${numbered}`;
  }

  // Return full file with line numbers, truncating if very large
  // Cap full-file reads at 200 lines (~15K chars / ~4K tokens).
  // For larger files the agent should use start_line/end_line ranges.
  const MAX_LINES = 200;
  if (total > MAX_LINES) {
    const head = lines.slice(0, 80).map((l, i) => `${i + 1}: ${l}`).join('\n');
    const tail = lines.slice(-40).map((l, i) => `${total - 39 + i}: ${l}`).join('\n');
    return `${input.path} (${total} lines — showing first 80 + last 40):\n\n${head}\n\n... [${total - 120} lines omitted — use start_line/end_line to read specific sections] ...\n\n${tail}`;
  }

  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `${input.path} (${total} lines):\n\n${numbered}`;
}

/**
 * Extract a PDF's text via poppler's pdftotext.
 *
 * `-layout` rather than raw order: the flag preserves columns, and without it
 * a two-column CV interleaves the sidebar into the body line by line, which
 * reads as corrupted text rather than as a document. Verified on a real
 * two-column resume — with -layout both columns come out cleanly separated.
 *
 * No fallback parser and no new dependency: poppler-utils is present on
 * essentially every Linux install and is a one-line apt on the rest, so the
 * honest failure is a message naming the package.
 */
function readPdf(filePath: string, input: ReadFileInput): string {
  let text: string;
  try {
    text = execFileSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === 'ENOENT') {
      return `Error: reading PDFs needs pdftotext, which is not installed. `
        + `Install poppler-utils (apt install poppler-utils / brew install poppler).`;
    }
    return `Error extracting PDF text: ${String(e).slice(0, 200)}`;
  }

  if (!text.trim()) {
    // A scanned PDF has no text layer at all. Say so, and point at the tool
    // that can actually help, rather than returning a convincing empty string.
    return `PDF has no extractable text (likely scanned images): ${input.path}\n`
      + `Render a page to an image and OCR it: pdftoppm -png -r 150 "${input.path}" /tmp/page `
      + `then use image_read with action=ocr.`;
  }

  const lines = text.split('\n');
  if (input.start_line !== undefined || input.end_line !== undefined) {
    const start = Math.max(1, input.start_line ?? 1) - 1;
    const end = Math.min(lines.length, input.end_line ?? lines.length);
    return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
  }
  return `PDF text (${lines.length} lines, via pdftotext -layout):\n`
    + lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
}

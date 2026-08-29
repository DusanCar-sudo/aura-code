import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { BINARY_EXTENSIONS } from '../config/defaults.js';
import { resolveInRoot, PathJailError } from '../safety/path-jail.js';
import { extractPdfText } from './pdf-text.js';

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

// Async only because a PDF may need the bundled parser, which is ESM and so
// must be reached through a dynamic import. Every other path returns
// immediately; executeTool already awaited this call.
export async function readFile(input: ReadFileInput, cwd: string): Promise<string> {
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
 * Extract a PDF's text.
 *
 * poppler's `pdftotext -layout` when it is available, and a bundled pdf.js
 * when it is not — see tools/pdf-text.ts for why both. `-layout` preserves
 * columns, and without it a two-column CV interleaves the sidebar into the
 * body line by line, which reads as corrupted text rather than as a document.
 *
 * This used to refuse outright when poppler was missing, which meant reading a
 * PDF simply did not work for anyone who had installed Aura from npm onto a
 * machine without it. A message naming an apt package is an honest failure,
 * but it is still a failure, and this one was avoidable.
 */
async function readPdf(filePath: string, input: ReadFileInput): Promise<string> {
  let text: string;
  let via: string;
  try {
    const extracted = await extractPdfText(filePath, true);
    text = extracted.text;
    via = extracted.via === 'pdftotext' ? 'pdftotext -layout' : 'bundled pdf.js';
  } catch (e) {
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
  return `PDF text (${lines.length} lines, via ${via}):\n`
    + lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
}

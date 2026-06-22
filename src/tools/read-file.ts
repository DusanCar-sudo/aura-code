import * as fs from 'fs';
import * as path from 'path';
import { BINARY_EXTENSIONS } from '../config/defaults.js';

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export function readFile(input: ReadFileInput, cwd: string): string {
  const filePath = path.resolve(cwd, input.path);

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${input.path}`;
  }

  const ext = path.extname(filePath).toLowerCase();
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

  // Hard byte ceiling, checked BEFORE the line-count check. Line-based
  // truncation alone is no protection: a file with few lines but one enormous
  // line (minified JS/CSS, a base64-inlined asset, a single-line data blob) can
  // still be many megabytes and, read in full, will blow past the model's
  // context window in one tool call. ~256 KB ≈ 70K+ tokens, plenty for a real
  // source file; anything larger must be read in slices.
  const MAX_BYTES = 256 * 1024;
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen > MAX_BYTES) {
    const head = content.slice(0, 4000);
    const tail = content.slice(-2000);
    return `${input.path} (${byteLen} bytes across ${total} lines — too large to inline; showing first 4000 + last 2000 chars). Use start_line/end_line to read specific sections, or grep_search to locate content:\n\n${head}\n\n... [${byteLen - 6000} bytes omitted] ...\n\n${tail}`;
  }

  // Return full file with line numbers, truncating if very large
  const MAX_LINES = 500;
  if (total > MAX_LINES) {
    const head = lines.slice(0, 80).map((l, i) => `${i + 1}: ${l}`).join('\n');
    const tail = lines.slice(-40).map((l, i) => `${total - 39 + i}: ${l}`).join('\n');
    return `${input.path} (${total} lines — showing first 80 + last 40):\n\n${head}\n\n... [${total - 120} lines omitted — use start_line/end_line to read specific sections] ...\n\n${tail}`;
  }

  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `${input.path} (${total} lines):\n\n${numbered}`;
}

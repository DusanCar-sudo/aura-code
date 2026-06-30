import * as fs from 'fs';
import * as path from 'path';

export interface EditFileInput {
  path: string;
  find: string;
  replace: string;
}

export function editFile(input: EditFileInput, cwd: string): string {
  const filePath = path.resolve(cwd, input.path);

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${input.path}`;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return `Error reading file: ${String(e)}`;
  }

  // Normalise line endings
  const normalContent = content.replace(/\r\n/g, '\n');
  const normalFind    = input.find.replace(/\r\n/g, '\n');
  const normalReplace = input.replace.replace(/\r\n/g, '\n');

  // ── Attempt 1: exact match ─────────────────────────────────────────────────
  if (normalContent.includes(normalFind)) {
    const newContent = normalContent.replace(normalFind, normalReplace);
    fs.writeFileSync(filePath, newContent, 'utf8');
    const lineCount = (normalFind.match(/\n/g) ?? []).length + 1;
    return `✓ Edit applied to ${input.path} (replaced ${lineCount} line${lineCount > 1 ? 's' : ''})`;
  }

  // ── Attempt 2: trimmed leading/trailing whitespace on each line ────────────
  const trimLines = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n');
  const trimmedContent = trimLines(normalContent);
  const trimmedFind    = trimLines(normalFind);

  if (trimmedContent.includes(trimmedFind)) {
    const newContent = trimmedContent.replace(trimmedFind, trimLines(normalReplace));
    fs.writeFileSync(filePath, newContent, 'utf8');
    return `✓ Edit applied to ${input.path} (whitespace-normalised match)`;
  }

  // ── Attempt 3: fuzzy — ignore all internal whitespace differences ──────────
  const collapse  = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
  const escaped   = collapse(normalFind).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+').replace(/\n/g, '\\s*\n\\s*');
  const fuzzyRegex = new RegExp(escaped, 'm');

  if (fuzzyRegex.test(normalContent)) {
    const newContent = normalContent.replace(fuzzyRegex, normalReplace.trim());
    fs.writeFileSync(filePath, newContent, 'utf8');
    return `✓ Edit applied to ${input.path} (fuzzy whitespace match)`;
  }

  // ── Check for multiple matches (ambiguous edit) ────────────────────────────
  const occurrences = normalContent.split(normalFind.split('\n')[0]).length - 1;

  // Nothing found — return helpful context
  const lines = normalContent.split('\n');
  const preview = lines.slice(0, 60).map((l, i) => `${i + 1}: ${l}`).join('\n');

  return [
    `Error: Could not find the specified block in ${input.path}.`,
    occurrences > 1 ? `Note: The first line of your find block appears ${occurrences} times — provide more context to disambiguate.` : '',
    ``,
    `The find block you provided:`,
    `---`,
    normalFind.split('\n').slice(0, 10).join('\n'),
    `---`,
    ``,
    `File starts with (first 60 lines):`,
    preview,
  ].filter(Boolean).join('\n');
}

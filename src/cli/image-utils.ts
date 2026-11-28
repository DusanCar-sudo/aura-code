import { readFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { extname, resolve } from 'path';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB, adjust to provider limits

export interface ImageLoadResult {
  dataUri: string | null;
  warning: string | null;
}

export function isSupportedImageExt(path: string): boolean {
  return extname(path).toLowerCase() in MIME_BY_EXT;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  return p;
}

export function decodeFileUri(uri: string): string | null {
  const trimmed = uri.trim();
  let rest: string | null = null;
  if (trimmed.startsWith('file://localhost')) rest = trimmed.slice('file://localhost'.length);
  else if (trimmed.startsWith('file://')) rest = trimmed.slice('file://'.length);
  else return null;
  if (!rest) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    decoded = rest;
  }
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  return decoded;
}

export function parseClipboardFileUris(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === 'copy' || trimmed === 'cut') continue;
    const decoded = decodeFileUri(trimmed);
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Splits pasted or typed command-line text into decoded path/word tokens,
 * supporting single-quoted `'a'\''b'`, double-quoted `"a b"`, backslash escapes,
 * and `file://` URIs.
 */
export function tokenizeShellInput(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && /\s/.test(raw[i]!)) i++;
    if (i >= n) break;
    let tok = '';
    while (i < n && !/\s/.test(raw[i]!)) {
      const ch = raw[i]!;
      if (ch === "'") {
        i++;
        while (i < n && raw[i] !== "'") {
          tok += raw[i++];
        }
        if (i < n && raw[i] === "'") i++;
      } else if (ch === '"') {
        i++;
        while (i < n && raw[i] !== '"') {
          if (raw[i] === '\\' && i + 1 < n && (raw[i + 1] === '"' || raw[i + 1] === '\\' || raw[i + 1] === '$')) {
            i++;
          }
          tok += raw[i++];
        }
        if (i < n && raw[i] === '"') i++;
      } else if (ch === '\\' && i + 1 < n) {
        i++;
        tok += raw[i++];
      } else {
        tok += raw[i++];
      }
    }
    if (tok) tokens.push(tok);
  }
  return tokens;
}

function resolveExistingFile(candidate: string, cwd = process.cwd()): string | null {
  let clean = candidate.trim();
  if (!clean) return null;
  if (clean.startsWith('file://')) {
    const uriPath = decodeFileUri(clean);
    if (!uriPath) return null;
    clean = uriPath;
  }
  // Ignore bare flags or URLs
  if (clean.startsWith('-') || /^[a-z]+:\/\//i.test(clean)) return null;
  const expanded = expandHome(clean);
  const full = resolve(cwd, expanded);
  try {
    if (existsSync(full) && statSync(full).isFile()) return full;
  } catch { /* unreadable */ }
  return null;
}

/**
 * Resolves a candidate token (raw path, quoted path, escaped path, or `file://` URI)
 * to an existing supported image file on disk, or null if not an existing image.
 */
export function resolveExistingImagePath(candidate: string, cwd = process.cwd()): string | null {
  const full = resolveExistingFile(candidate, cwd);
  if (!full || !isSupportedImageExt(full)) return null;
  return full;
}

/**
 * Checks whether an entire pasted payload represents one or more dropped/copied files
 * where at least one file is a supported image. Handles `text/uri-list` /
 * `x-special/gnome-copied-files` and shell-quoted / escaped / raw paths.
 */
export function extractAllImagePastePaths(
  raw: string,
  cwd = process.cwd(),
): { imagePaths: string[]; otherPaths: string[] } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const uriLines = parseClipboardFileUris(trimmed);
  const candidates = uriLines.length > 0 && uriLines.length === trimmed.split(/\r?\n/).filter(l => {
    const t = l.trim();
    return t && !t.startsWith('#') && t !== 'copy' && t !== 'cut';
  }).length
    ? uriLines
    : tokenizeShellInput(trimmed);

  if (candidates.length === 0) return null;
  const imagePaths: string[] = [];
  const otherPaths: string[] = [];
  for (const cand of candidates) {
    const full = resolveExistingFile(cand, cwd);
    if (!full) return null;
    if (isSupportedImageExt(full)) imagePaths.push(full);
    else otherPaths.push(full);
  }
  return imagePaths.length > 0 ? { imagePaths, otherPaths } : null;
}

/**
 * Extracts all existing image file paths mentioned anywhere inside a submitted prompt
 * (from raw drag-and-drop without bracketed paste, quoted paths, or file:// URIs).
 */
export function extractImagePathsFromPrompt(prompt: string, cwd = process.cwd()): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const token of tokenizeShellInput(prompt)) {
    const clean = token.replace(/^[,(\[]+/, '').replace(/[,.;:)\]]+$/, '');
    const resolved = resolveExistingImagePath(clean, cwd) ?? resolveExistingImagePath(token, cwd);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      found.push(resolved);
    }
  }
  return found;
}

/**
 * Reads an image file from disk and returns a base64 data URI
 * (e.g. "data:image/png;base64,...") suitable for HistoryMessage.images.
 * Never throws — returns a warning string instead so the CLI can decide
 * whether to abort or continue text-only.
 */
export function loadImageAsDataUri(path: string): ImageLoadResult {
  if (!existsSync(path)) {
    return { dataUri: null, warning: `Image not found: ${path}` };
  }

  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return {
      dataUri: null,
      warning: `Unsupported image type "${ext}" for ${path}. Supported: ${Object.keys(MIME_BY_EXT).join(', ')}`,
    };
  }

  const stat = statSync(path);
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      dataUri: null,
      warning: `Image ${path} is ${(stat.size / 1024 / 1024).toFixed(1)}MB, exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
    };
  }

  try {
    const buf = readFileSync(path);
    const base64 = buf.toString('base64');
    return { dataUri: `data:${mime};base64,${base64}`, warning: null };
  } catch (err) {
    return { dataUri: null, warning: `Failed to read ${path}: ${(err as Error).message}` };
  }
}

/**
 * Loads multiple images, collecting warnings for any that fail.
 * Returns only the successfully loaded data URIs.
 */
export function loadImages(paths: string[]): { images: string[]; warnings: string[] } {
  const images: string[] = [];
  const warnings: string[] = [];
  for (const p of paths) {
    const { dataUri, warning } = loadImageAsDataUri(p);
    if (dataUri) images.push(dataUri);
    if (warning) warnings.push(warning);
  }
  return { images, warnings };
}

const VISION_MODEL_HINTS = [
  'vl', 'vision', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'o3', 'o4',
  'claude-3', 'claude-4', 'claude-sonnet-4', 'claude-opus-4', 'claude-haiku-4',
  'gemini', 'gemma-3', 'gemma3', 'pixtral', 'llava', 'qwen3-vl', 'qwen2.5-vl',
];

/** Soft heuristic — warn, never block, when a model name has no vision hint. */
export function looksVisionCapable(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return VISION_MODEL_HINTS.some(hint => lower.includes(hint));
}

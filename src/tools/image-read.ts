import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { run, hasCommand } from '../util/exec.js';
import type { ToolDefinition } from '../providers/types.js';

/**
 * Normalize a user-supplied image location into an absolute filesystem path.
 * Accepts plain paths and `file://` URLs (including percent-encoded ones and
 * `file://localhost/...`), which is how editors/terminals hand off screenshots.
 */
function normalizeImagePath(raw: string): string {
  let p = raw.trim().replace(/^["']|["']$/g, '');  // strip surrounding quotes
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);                          // handles %20 etc. + localhost host
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/, ''));
    }
  }
  return path.resolve(p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Read — read image metadata and extract text (OCR)
// ─────────────────────────────────────────────────────────────────────────────

export interface ImageReadInput {
  path: string;
  action?: 'info' | 'ocr' | 'base64';
}

export const IMAGE_READ_DEFINITION: ToolDefinition = {
  name: 'image_read',
  description:
    'Read an image file. Actions: info (dimensions, size, format), ocr (extract text using tesseract), ' +
    'base64 (attach the image for LLM vision). Useful for screenshots, documents, diagrams.',
  parameters: {
    type: 'object',
    properties: {
      path:   { type: 'string', description: 'Path to the image file' },
      action: { type: 'string', description: 'Action: info, ocr, base64 (default: info)' },
    },
    required: ['path'],
  },
};

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.svg', '.ico'];

function getInfo(filePath: string): string {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const sizeKB = (stat.size / 1024).toFixed(1);

  let dimensions = 'unknown';
  try {
    // Try using `file` command for basic info
    const fileInfo = run('file', ['--', filePath], { timeoutMs: 10_000 }).stdout.trim();
    // Extract dimensions from file output if available
    const dimMatch = fileInfo.match(/(\d+)\s*x\s*(\d+)/);
    if (dimMatch) dimensions = `${dimMatch[1]}x${dimMatch[2]}`;
  } catch { /* ignore */ }

  return [
    `File: ${filePath}`,
    `Size: ${sizeKB} KB`,
    `Format: ${ext.slice(1).toUpperCase()}`,
    `Dimensions: ${dimensions}`,
    `Modified: ${stat.mtime.toISOString()}`,
  ].join('\n');
}

function doOcr(filePath: string): string {
  if (!hasCommand('tesseract')) {
    return 'Error: tesseract not installed. Install with: sudo apt install tesseract-ocr';
  }
  const r = run('tesseract', [filePath, 'stdout'], { timeoutMs: 120_000 });
  if (r.error || r.status !== 0) {
    return `OCR error: ${r.error?.message ?? (r.stderr.trim().split('\n').pop() || `exit ${r.status}`)}`;
  }
  return `OCR result:\n${r.stdout.trim()}`;
}

/** The image type from the file's first bytes, or null when it isn't one. */
export function sniffImage(b: Buffer): string | null {
  const hex = b.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('424d')) return 'image/bmp';
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'image/tiff';
  if (hex.startsWith('00000100')) return 'image/x-icon';
  const head = b.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(head)) return 'image/svg+xml';
  return null;
}

/** Max raw file size (bytes) allowed for base64 — larger images would flood context. */
const MAX_BASE64_BYTES = 500_000;  // ~670 KB base64 output

/** Vision attachment — mirrors the computer screenshot shape ({ text, images })
 *  so the base64 travels as an image block, never as visible text. */
export interface ImageAttachment {
  text: string;
  images: string[];
}

function doBase64(filePath: string): ImageAttachment {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BASE64_BYTES) {
    const kb = (stat.size / 1024).toFixed(1);
    const limit = (MAX_BASE64_BYTES / 1024).toFixed(0);
    // Errors stay plain strings (callers sniff the "Error:" prefix).
    const err = [
      `Error: image too large for base64 (${kb} KB > ${limit} KB limit).`,
      `To use this image for vision:`,
      `  1. Resize:   convert "${filePath}" -resize 50% /tmp/smaller.png`,
      `  2. Then:     image_read path=/tmp/smaller.png action=base64`,
      `Or use action=info to inspect it without encoding.`,
    ].join('\n');
    return { text: err, images: [] };
  }

  const buffer = fs.readFileSync(filePath);
  // The bytes decide, not the name: this branch used to encode any readable
  // file (a key, a config) and hand it to the model as an "image".
  const mime = sniffImage(buffer);
  if (!mime) {
    return { text: `Error: ${filePath} is not an image (its contents don't match any supported image format).`, images: [] };
  }
  const b64 = buffer.toString('base64');
  const sizeKB = (stat.size / 1024).toFixed(1);
  return {
    text: `Image attached for vision: ${filePath} (${sizeKB} KB, ${mime}). `
      + 'It is attached to this result as an image — never print base64 data.',
    images: [`data:${mime};base64,${b64}`],
  };
}

export async function imageRead(input: ImageReadInput): Promise<string | ImageAttachment> {
  const filePath = normalizeImagePath(input.path);

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${input.path} (resolved to ${filePath})`;
  }

  const ext = path.extname(filePath).toLowerCase();
  const action = input.action ?? 'info';

  // base64 checks the bytes itself (sniffImage), so any extension is fine here
  if (action === 'base64') {
    const out = doBase64(filePath);
    // Errors flow back as plain text so the usual "Error:" handling applies.
    return out.images.length ? out : out.text;
  }

  // For info/ocr, check it's an image
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    return `Error: Not an image file (${ext}). Supported: ${IMAGE_EXTENSIONS.join(', ')}`;
  }

  switch (action) {
    case 'info': return getInfo(filePath);
    case 'ocr':  return doOcr(filePath);
    default:     return `Error: Unknown image_read action: ${action}`;
  }
}

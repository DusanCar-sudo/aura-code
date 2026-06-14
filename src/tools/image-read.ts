import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ToolDefinition } from '../providers/types.js';

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
    'base64 (return base64-encoded data for LLM vision). Useful for screenshots, documents, diagrams.',
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
    const fileInfo = execSync(`file "${filePath}"`, { encoding: 'utf8' }).trim();
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
  try {
    execSync('which tesseract', { stdio: 'pipe' });
  } catch {
    return 'Error: tesseract not installed. Install with: sudo apt install tesseract-ocr';
  }

  try {
    const text = execSync(`tesseract "${filePath}" stdout 2>/dev/null`, { encoding: 'utf8' });
    return `OCR result:\n${text.trim()}`;
  } catch (e: any) {
    return `OCR error: ${e?.message}`;
  }
}

function doBase64(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    svg: 'image/svg+xml', tiff: 'image/tiff', ico: 'image/x-icon',
  };
  const mime = mimeMap[ext] ?? 'application/octet-stream';
  const b64 = buffer.toString('base64');
  return `data:${mime};base64,${b64}`;
}

export async function imageRead(input: ImageReadInput): Promise<string> {
  const filePath = path.resolve(input.path);

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${input.path}`;
  }

  const ext = path.extname(filePath).toLowerCase();
  const action = input.action ?? 'info';

  // For base64, allow any file
  if (action === 'base64') {
    return doBase64(filePath);
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

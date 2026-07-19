import { readFileSync, existsSync, statSync } from 'fs';
import { extname } from 'path';

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

const VISION_MODEL_HINTS = ['vl', 'vision', 'gpt-4o', 'claude-3', 'gemini', 'qwen3-vl'];

/** Soft heuristic — warn, never block, when a model name has no vision hint. */
export function looksVisionCapable(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return VISION_MODEL_HINTS.some(hint => lower.includes(hint));
}

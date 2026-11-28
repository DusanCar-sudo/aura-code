import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { ToolDefinition } from '../providers/types.js';
import { parseClipboardFileUris } from '../cli/image-utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Clipboard — system clipboard read/write (text, file URIs, and images)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClipboardInput {
  action: 'copy' | 'paste';
  text?: string;
}

export type ClipboardMediaResult =
  | { kind: 'image'; path: string }
  | { kind: 'files'; paths: string[] };

export const CLIPBOARD_DEFINITION: ToolDefinition = {
  name: 'clipboard',
  description:
    'Read from or write to the system clipboard. Copy text for the user to paste, ' +
    'or read what the user has copied.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: copy (write to clipboard) or paste (read from clipboard)' },
      text:   { type: 'string', description: 'Text to copy (required for copy action)' },
    },
    required: ['action'],
  },
};

function winClipboardCopy(text: string): void {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
  ], { input: text, timeout: 5000, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(String(r.stderr || 'powershell Set-Clipboard failed').trim());
  }
}

function winClipboardPaste(): string {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw',
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) {
    throw new Error(String(r.stderr || 'powershell Get-Clipboard failed').trim());
  }
  return r.stdout || '';
}

function detectClipboardCommand(): { copy: string[]; paste: string[] } | null {
  if (process.platform === 'win32') return { copy: ['__win32__'], paste: ['__win32__'] };

  // Try xclip (X11)
  try {
    execSync('which xclip', { stdio: 'pipe' });
    return {
      copy: ['xclip', '-selection', 'clipboard'],
      paste: ['xclip', '-selection', 'clipboard', '-o'],
    };
  } catch { /* not found */ }

  // Try xsel (X11)
  try {
    execSync('which xsel', { stdio: 'pipe' });
    return {
      copy: ['xsel', '--clipboard', '--input'],
      paste: ['xsel', '--clipboard', '--output'],
    };
  } catch { /* not found */ }

  // Try wl-copy/wl-paste (Wayland)
  try {
    execSync('which wl-copy', { stdio: 'pipe' });
    return {
      copy: ['wl-copy'],
      paste: ['wl-paste'],
    };
  } catch { /* not found */ }

  // Try pbcopy/pbpaste (macOS)
  try {
    execSync('which pbcopy', { stdio: 'pipe' });
    return {
      copy: ['pbcopy'],
      paste: ['pbpaste'],
    };
  } catch { /* not found */ }

  return null;
}

function clipboardImageCacheDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg || join(homedir() || tmpdir(), '.cache');
  return join(base, 'aura-code', 'pasted');
}

function imageExtForMimeOrBytes(buf: Buffer, mime: string): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const m = mime.toLowerCase();
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

function saveClipboardImageBuffer(buf: Buffer, mime: string, cacheDir?: string): string {
  const dir = clipboardImageCacheDir(cacheDir);
  mkdirSync(dir, { recursive: true });
  const ext = imageExtForMimeOrBytes(buf, mime);
  const filename = `clip-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const outPath = join(dir, filename);
  writeFileSync(outPath, buf);
  return outPath;
}

function runRawSync(bin: string, args: string[]): Buffer | null {
  if (typeof spawnSync !== 'function') return null;
  try {
    const res = spawnSync(bin, args, { timeout: 5000, windowsHide: true });
    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) return null;
    return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout));
  } catch {
    return null;
  }
}

function probeMediaTargets(
  targets: string[],
  readMime: (mime: string) => Buffer | null,
  cacheDir?: string,
): ClipboardMediaResult | null {
  for (const uriMime of ['x-special/gnome-copied-files', 'text/uri-list']) {
    const found = targets.find(t => t.toLowerCase() === uriMime);
    if (!found) continue;
    const raw = readMime(found);
    if (!raw) continue;
    const paths = parseClipboardFileUris(raw.toString('utf8')).filter(p => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (paths.length > 0) return { kind: 'files', paths };
  }

  for (const imgMime of ['image/png', 'image/webp', 'image/jpeg', 'image/gif']) {
    const found = targets.find(t => {
      const l = t.trim().toLowerCase();
      return l === imgMime || l.startsWith(`${imgMime};`);
    });
    if (!found) continue;
    const raw = readMime(found);
    if (raw && raw.length > 0) {
      return { kind: 'image', path: saveClipboardImageBuffer(raw, found, cacheDir) };
    }
  }
  return null;
}

/**
 * Read image bytes or file URIs from the system clipboard when plain-text
 * clipboard read finds no text (e.g., screenshots copied to clipboard, or files
 * copied in a desktop file manager). Returns null when empty or unavailable.
 */
export function readClipboardMediaSync(cacheDir?: string): ClipboardMediaResult | null {
  if (process.env.VITEST && !process.env.AURA_TEST_CLIPBOARD_MEDIA) return null;
  if (typeof spawnSync !== 'function') return null;

  if (process.platform === 'win32') {
    try {
      const dir = clipboardImageCacheDir(cacheDir);
      mkdirSync(dir, { recursive: true });
      const outFile = join(dir, `clip-${Date.now()}-${process.pid}.png`);
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
        '  $files = [System.Windows.Forms.Clipboard]::GetFileDropList();',
        '  foreach ($f in $files) { Write-Output ("FILE:" + $f) }',
        '} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
        `  $img = [System.Windows.Forms.Clipboard]::GetImage(); $img.Save('${outFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
        '  Write-Output "IMG_OK"',
        '}',
      ].join(' ');
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const files = lines.filter(l => l.startsWith('FILE:')).map(l => l.slice(5)).filter(p => existsSync(p));
        if (files.length > 0) return { kind: 'files', paths: files };
        if (lines.includes('IMG_OK') && existsSync(outFile)) return { kind: 'image', path: outFile };
      }
    } catch { /* ignore */ }
    return null;
  }

  if (process.platform === 'darwin') {
    const png = runRawSync('pngpaste', ['-']);
    if (png && png.length > 0) return { kind: 'image', path: saveClipboardImageBuffer(png, 'image/png', cacheDir) };
    const dir = clipboardImageCacheDir(cacheDir);
    mkdirSync(dir, { recursive: true });
    const outFile = join(dir, `clip-${Date.now()}-${process.pid}.png`);
    const r = spawnSync('osascript', [
      '-e',
      `set f to open for access POSIX file "${outFile}" with write permission\ntry\nwrite (the clipboard as «class PNGf») to f\nclose access f\non error\nclose access f\nerror "no png"\nend try`,
    ], { timeout: 5000 });
    if (r.status === 0 && existsSync(outFile)) return { kind: 'image', path: outFile };
    return null;
  }

  if (process.env.WAYLAND_DISPLAY) {
    const rawTypes = runRawSync('wl-paste', ['--list-types']);
    if (rawTypes) {
      const targets = rawTypes.toString('utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const found = probeMediaTargets(
        targets,
        mime => runRawSync('wl-paste', ['--no-newline', '--type', mime]),
        cacheDir,
      );
      if (found) return found;
    }
  }

  if (process.env.DISPLAY) {
    const rawTargets = runRawSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
    if (rawTargets) {
      const targets = rawTargets.toString('utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const found = probeMediaTargets(
        targets,
        mime => runRawSync('xclip', ['-selection', 'clipboard', '-t', mime, '-o']),
        cacheDir,
      );
      if (found) return found;
    }
  }

  return null;
}

/**
 * Read the system clipboard, or null when no utility is installed or the read
 * fails. Synchronous on purpose: the TUI's right-click-to-paste handler runs in
 * a sync mouse-event path and a deliberate click can afford one `execSync`.
 */
export function readClipboardSync(): string | null {
  if (process.platform === 'win32') {
    try { return winClipboardPaste(); }
    catch { return null; }
  }
  const cmds = detectClipboardCommand();
  if (!cmds) return null;
  try {
    const [bin, ...args] = cmds.paste;
    return execSync(`${bin} ${args.join(' ')}`, { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
}

export async function clipboardTool(input: ClipboardInput): Promise<string> {
  if (process.platform === 'win32') {
    if (input.action === 'copy') {
      if (input.text === undefined) return 'Error: text is required for copy';
      try {
        winClipboardCopy(input.text);
        return `Copied ${input.text.length} characters to clipboard.`;
      } catch (e: any) {
        return `Error copying to clipboard: ${e?.message}`;
      }
    }
    if (input.action === 'paste') {
      try {
        return `Clipboard contents:\n${winClipboardPaste()}`;
      } catch (e: any) {
        return `Error reading clipboard: ${e?.message}`;
      }
    }
    return `Error: Unknown clipboard action: ${input.action}`;
  }

  const cmds = detectClipboardCommand();
  if (!cmds) {
    return 'Error: No clipboard utility found. Install xclip, xsel, or wl-clipboard.';
  }

  switch (input.action) {
    case 'copy': {
      if (input.text === undefined) return 'Error: text is required for copy';
      try {
        const [bin, ...args] = cmds.copy;
        // stdout/stderr must be ignored: wl-copy (and xclip) fork a daemon
        // that inherits them, so with pipes execSync never returns.
        execSync(`${bin} ${args.join(' ')}`, {
          input: input.text,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 5000,
        });
        return `Copied ${input.text.length} characters to clipboard.`;
      } catch (e: any) {
        return `Error copying to clipboard: ${e?.message}`;
      }
    }

    case 'paste': {
      try {
        const [bin, ...args] = cmds.paste;
        const result = execSync(`${bin} ${args.join(' ')}`, { encoding: 'utf8' });
        return `Clipboard contents:\n${result}`;
      } catch (e: any) {
        return `Error reading clipboard: ${e?.message}`;
      }
    }

    default:
      return `Error: Unknown clipboard action: ${input.action}`;
  }
}

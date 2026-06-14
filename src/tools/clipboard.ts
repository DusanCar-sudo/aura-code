import { execSync } from 'child_process';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Clipboard — system clipboard read/write
// ─────────────────────────────────────────────────────────────────────────────

export interface ClipboardInput {
  action: 'copy' | 'paste';
  text?: string;
}

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

function detectClipboardCommand(): { copy: string[]; paste: string[] } | null {
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

export async function clipboardTool(input: ClipboardInput): Promise<string> {
  const cmds = detectClipboardCommand();
  if (!cmds) {
    return 'Error: No clipboard utility found. Install xclip, xsel, or wl-clipboard.';
  }

  switch (input.action) {
    case 'copy': {
      if (input.text === undefined) return 'Error: text is required for copy';
      try {
        const [bin, ...args] = cmds.copy;
        execSync(`${bin} ${args.join(' ')}`, { input: input.text });
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

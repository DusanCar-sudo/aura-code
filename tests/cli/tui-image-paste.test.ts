import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ClipboardMediaResult } from '../../src/tools/clipboard.js';

const clip = vi.hoisted(() => ({
  text: null as string | null,
  media: null as ClipboardMediaResult | null,
}));

vi.mock('../../src/tools/clipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/clipboard.js')>()),
  readClipboardSync: () => clip.text,
  readClipboardMediaSync: () => clip.media,
}));

import {
  extractAllImagePastePaths,
  extractImagePathsFromPrompt,
  parseClipboardFileUris,
} from '../../src/cli/image-utils.js';
import {
  clearInputHistory,
  destroyTui,
  initTui,
  setCallbacks,
  startInput,
} from '../../src/cli/tui.js';
import { toAnthropicMessages } from '../../src/providers/anthropic.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?<]*[A-Za-z~]/g, '');
}

describe('TUI image paste and drag-and-drop', () => {
  let tempDir = '';
  let chunks: string[] = [];
  const stdoutState = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aura-img-paste-'));
    chunks = [];
    clip.text = null;
    clip.media = null;
    clearInputHistory();
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 28 });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    destroyTui();
    vi.restoreAllMocks();
    if (stdoutState.columns) Object.defineProperty(process.stdout, 'columns', stdoutState.columns);
    if (stdoutState.rows) Object.defineProperty(process.stdout, 'rows', stdoutState.rows);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts quoted, escaped, and file:// URI image paths', () => {
    const img1 = join(tempDir, 'Screenshot 1.png');
    const img2 = join(tempDir, 'diagram.webp');
    writeFileSync(img1, Buffer.from('\x89PNG\r\n\x1a\n'));
    writeFileSync(img2, Buffer.from('RIFF\x00\x00\x00\x00WEBP'));

    const singleQuoted = `'${img1}' '${img2}'`;
    expect(extractAllImagePastePaths(singleQuoted)).toEqual({
      imagePaths: [img1, img2],
      otherPaths: [],
    });

    const uriList = `copy\nfile://${encodeURI(img1)}\n`;
    expect(parseClipboardFileUris(uriList)).toEqual([img1]);
    expect(extractAllImagePastePaths(uriList)).toEqual({
      imagePaths: [img1],
      otherPaths: [],
    });

    const escaped = img1.replace(/ /g, '\\ ');
    expect(extractAllImagePastePaths(escaped)).toEqual({
      imagePaths: [img1],
      otherPaths: [],
    });

    expect(extractImagePathsFromPrompt(`please inspect '${img1}'`)).toEqual([img1]);
  });

  it('turns dragged or bracket-pasted image path into [Image #N] chip and forwards attachedImages on submit', () => {
    const img = join(tempDir, 'shot with spaces.png');
    writeFileSync(img, Buffer.from('\x89PNG\r\n\x1a\n'));

    initTui();
    startInput();
    let submittedText = '';
    let submittedImages: string[] | undefined;
    setCallbacks({
      onEnter: (line, imgs) => {
        submittedText = line;
        submittedImages = imgs;
      },
    });
    chunks = [];

    process.stdin.emit('data', `\x1b[200~'${img}'\x1b[201~`);
    const rendered = stripAnsi(chunks.join(''));
    expect(rendered).toContain('[Image #');
    expect(rendered).toContain('shot with spaces.png]');

    process.stdin.emit('data', 'what broke?\r');
    expect(submittedText).toBe('what broke?');
    expect(submittedImages).toEqual([img]);
  });

  it('handles Ctrl+V with a clipboard image even when plain text clipboard is empty', () => {
    const img = join(tempDir, 'clip-99.png');
    writeFileSync(img, Buffer.from('\x89PNG\r\n\x1a\n'));
    clip.text = null;
    clip.media = { kind: 'image', path: img };

    initTui();
    startInput();
    let submittedText = '';
    let submittedImages: string[] | undefined;
    setCallbacks({
      onEnter: (line, imgs) => {
        submittedText = line;
        submittedImages = imgs;
      },
    });
    chunks = [];

    process.stdin.emit('data', '\x16'); // Ctrl+V
    expect(stripAnsi(chunks.join(''))).toContain('clip-99.png]');

    process.stdin.emit('data', '\r'); // Submit image alone without requiring extra text
    expect(submittedText).toBe('');
    expect(submittedImages).toEqual([img]);
  });

  it('removes an attached image chip atomically on Backspace', () => {
    const img = join(tempDir, 'remove-me.png');
    writeFileSync(img, Buffer.from('\x89PNG\r\n\x1a\n'));

    initTui();
    startInput();
    let submittedText = '';
    let submittedImages: string[] | undefined;
    setCallbacks({
      onEnter: (line, imgs) => {
        submittedText = line;
        submittedImages = imgs;
      },
    });

    process.stdin.emit('data', `\x1b[200~${img}\x1b[201~`);
    process.stdin.emit('data', '\x7f'); // single Backspace removes entire [Image #N: ...] chip
    process.stdin.emit('data', 'only text\r');

    expect(submittedText).toBe('only text');
    expect(submittedImages).toBeUndefined();
  });

  it('serializes user images into Anthropic base64 image content blocks', () => {
    const messages = toAnthropicMessages([
      {
        role: 'user',
        content: 'Describe this screenshot',
        images: ['data:image/png;base64,iVBORw0KGgo='],
      },
    ]);
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Describe this screenshot' });
  });
});

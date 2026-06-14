import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { imageRead, IMAGE_READ_DEFINITION } from '../src/tools/image-read.js';

const testDir = path.join(os.tmpdir(), 'ruby-test-image-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(testDir, { recursive: true });
  // Create a fake PNG (minimal)
  fs.writeFileSync(path.join(testDir, 'test.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('IMAGE_READ_DEFINITION', () => {
  it('has correct name', () => expect(IMAGE_READ_DEFINITION.name).toBe('image_read'));
  it('requires path', () => expect(IMAGE_READ_DEFINITION.parameters.required).toEqual(['path']));
});

describe('imageRead — info', () => {
  it('returns file info for valid image', async () => {
    const r = await imageRead({ path: path.join(testDir, 'test.png'), action: 'info' });
    expect(r).toContain('File:');
    expect(r).toContain('Size:');
    expect(r).toContain('PNG');
  });

  it('returns error for missing file', async () => {
    const r = await imageRead({ path: '/nonexistent/image.png' });
    expect(r).toContain('Error: File not found');
  });

  it('returns error for non-image file', async () => {
    fs.writeFileSync(path.join(testDir, 'text.txt'), 'hello');
    const r = await imageRead({ path: path.join(testDir, 'text.txt'), action: 'info' });
    expect(r).toContain('Error: Not an image');
  });
});

describe('imageRead — base64', () => {
  it('returns base64 data', async () => {
    const r = await imageRead({ path: path.join(testDir, 'test.png'), action: 'base64' });
    expect(r).toContain('data:image/png;base64,');
  });
});

describe('imageRead — ocr', () => {
  it('returns error when tesseract not installed', async () => {
    vi.mock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => { throw new Error('not found'); }),
    }));
    const r = await imageRead({ path: path.join(testDir, 'test.png'), action: 'ocr' });
    expect(r).toContain('Error');
  });
});

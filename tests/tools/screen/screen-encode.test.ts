import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENCODER_DIR = path.resolve(here, '../../../src/tools/screen');

/** Runs encode_png in a real python3 and returns what it reported plus the PNG's pixel size. */
function encodeAndMeasure(w: number, h: number, maxPixels: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'));
  const out = path.join(dir, 'shot.png');
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(ENCODER_DIR)})`,
    'from screen_encode import encode_png',
    `data = bytes([120, 60, 200]) * (${w} * ${h})`,
    `tw, th, scale = encode_png(data, ${w}, ${h}, ${JSON.stringify(out)}, ${maxPixels})`,
    'print(json.dumps({"tw": tw, "th": th, "scale": scale}))',
  ].join('\n');
  try {
    const reported = JSON.parse(execFileSync('python3', ['-I', '-c', script]).toString());
    // PNG IHDR: width and height are big-endian uint32 at byte offsets 16 and 20.
    const header = fs.readFileSync(out);
    return { reported, pngW: header.readUInt32BE(16), pngH: header.readUInt32BE(20) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('screen_encode.encode_png', () => {
  it('downscales to the pixel budget and the file matches what it reports', () => {
    const { reported, pngW, pngH } = encodeAndMeasure(2000, 1000, 500_000);
    expect(pngW).toBe(reported.tw);
    expect(pngH).toBe(reported.th);
    expect(pngW * pngH).toBeLessThanOrEqual(500_001);
    expect(reported.scale).toBeLessThan(1);
  });

  it('never upscales a frame that already fits the budget', () => {
    const { reported, pngW, pngH } = encodeAndMeasure(320, 200, 1_100_000);
    expect([pngW, pngH]).toEqual([320, 200]);
    expect(reported.scale).toBe(1);
  });
});

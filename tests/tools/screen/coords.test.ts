import { describe, it, expect } from 'vitest';
import {
  fitScale, imageToLogical, isInsideImage, geometryKey, type CaptureGeometry,
} from '../../../src/tools/screen/coords.js';

/** The real geometry from the development machine, kept as the fixture so the
 *  numbers in these tests are ones that actually occurred. */
const G: CaptureGeometry = {
  sourceWidth: 2259, sourceHeight: 2471, width: 1002, height: 1096,
};

describe('fitScale', () => {
  it('shrinks a large screen to the pixel budget', () => {
    const s = fitScale(2259, 2471, 1_100_000);
    expect(s).toBeCloseTo(0.4439, 3);
    expect(2259 * s * 2471 * s).toBeLessThanOrEqual(1_100_001);
  });

  it('never upscales a small image', () => {
    expect(fitScale(320, 200, 1_100_000)).toBe(1);
  });

  it('treats a missing or zero budget as no limit', () => {
    expect(fitScale(4000, 4000, 0)).toBe(1);
    expect(fitScale(4000, 4000, Number.NaN)).toBe(1);
  });
});

describe('imageToLogical', () => {
  it('maps the point that actually worked in the live test', () => {
    // Chrome's address bar, read off the screenshot at (200,591); the click
    // that opened leanproiq.com went to (451,1332).
    expect(imageToLogical(200, 591, G)).toEqual({ x: 451, y: 1332 });
  });

  it('maps the origin and the far corner exactly', () => {
    expect(imageToLogical(0, 0, G)).toEqual({ x: 0, y: 0 });
    expect(imageToLogical(G.width, G.height, G)).toEqual({ x: 2259, y: 2471 });
  });

  it('clamps a point outside the image instead of saturating silently', () => {
    // An absolute input device clamps internally, so an unclamped coordinate
    // lands somewhere nobody asked for and looks like a misgrounded click.
    expect(imageToLogical(-50, -50, G)).toEqual({ x: 0, y: 0 });
    expect(imageToLogical(99999, 99999, G)).toEqual({ x: 2259, y: 2471 });
  });

  it('refuses a geometry with no size rather than dividing by zero', () => {
    expect(() => imageToLogical(1, 1, { ...G, width: 0 })).toThrow(/no size/);
  });

  it('is identity when the capture was not downscaled', () => {
    const same = { sourceWidth: 800, sourceHeight: 600, width: 800, height: 600 };
    expect(imageToLogical(123, 456, same)).toEqual({ x: 123, y: 456 });
  });
});

describe('isInsideImage', () => {
  it('separates a real point from one that had to be clamped', () => {
    expect(isInsideImage(200, 591, G)).toBe(true);
    expect(isInsideImage(1003, 591, G)).toBe(false);
    expect(isInsideImage(200, -1, G)).toBe(false);
  });
});

describe('geometryKey', () => {
  it('describes the screen a lesson was learned on', () => {
    expect(geometryKey(G)).toBe('2259x2471');
  });
});

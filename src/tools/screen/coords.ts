/**
 * Mapping between the screenshot the model sees and the screen the pointer
 * moves on.
 *
 * These are two different coordinate spaces and conflating them is the easiest
 * way to build a computer-use agent that misses every click. A capture is
 * downscaled before it is sent — on the development machine 2259x2471 becomes
 * 1002x1096 — so a model reading a button at (200, 591) in the image means
 * (451, 1332) on screen. Nothing in either number says which space it is in,
 * and a factor-of-2.25 error still lands somewhere plausible on a busy desktop,
 * so it fails as a wrong click rather than as an error.
 *
 * The rule this module enforces: **the model always speaks image coordinates**,
 * and conversion happens once, here, on the way to the input device. Asking the
 * model to scale its own coordinates would be asking it to do arithmetic it
 * cannot check, in a place where being wrong is invisible.
 */

/** What a capture reports about itself, from the sidecar. */
export interface CaptureGeometry {
  /** Real screen size in the input device's units. */
  sourceWidth: number;
  sourceHeight: number;
  /** Size of the PNG the model was shown. */
  width: number;
  height: number;
}

export interface Point { x: number; y: number }

/**
 * Largest scale factor that fits `w*h` into `maxPixels`, never upscaling.
 * Returns 1 when the image already fits or when maxPixels is 0/absent, so
 * "no limit" is expressible without a special case at the call site.
 */
export function fitScale(w: number, h: number, maxPixels: number): number {
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return 1;
  if (w <= 0 || h <= 0) return 1;
  return Math.min(1, Math.sqrt(maxPixels / (w * h)));
}

/**
 * Convert a point the model read off the screenshot into screen coordinates.
 *
 * Clamped to the screen: a model that names a point slightly outside the image
 * (off-by-one at an edge, or a hallucinated coordinate) should click the edge
 * rather than have the whole action rejected — but it must never be handed to
 * the input device unclamped, because an absolute device silently saturates
 * and the click then lands somewhere the model did not ask for.
 */
export function imageToLogical(x: number, y: number, g: CaptureGeometry): Point {
  if (g.width <= 0 || g.height <= 0) {
    throw new Error(`capture geometry has no size: ${g.width}x${g.height}`);
  }
  const sx = g.sourceWidth / g.width;
  const sy = g.sourceHeight / g.height;
  return {
    x: clamp(Math.round(x * sx), 0, g.sourceWidth),
    y: clamp(Math.round(y * sy), 0, g.sourceHeight),
  };
}

/** True when the point actually fell inside the image, so callers can warn
 *  about a coordinate that was clamped rather than let it pass as intended. */
export function isInsideImage(x: number, y: number, g: CaptureGeometry): boolean {
  return x >= 0 && y >= 0 && x <= g.width && y <= g.height;
}

/** Human-readable geometry key, used to tell whether a remembered coordinate
 *  was learned on this screen layout (see screen/lessons.ts). */
export function geometryKey(g: Pick<CaptureGeometry, 'sourceWidth' | 'sourceHeight'>): string {
  return `${g.sourceWidth}x${g.sourceHeight}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

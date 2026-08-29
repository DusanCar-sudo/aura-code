/**
 * Screenshots taken at the moment of a click.
 *
 * They exist because Wayland will not say where the pointer is (see
 * record/types.ts), so the picture is the only record of *what* was clicked.
 * The capture already runs with the cursor composited into the frame, which is
 * what makes that work.
 *
 * Everything here degrades rather than fails. A recording without shots is
 * still a usable step list; a recording that could not be made because the
 * screen sidecar was unavailable is nothing at all. So a capture that does not
 * work returns null and the demonstration carries on.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ScreenSidecar } from '../tools/screen/sidecar.js';

export interface ShotTaker {
  /** Capture now; resolves to the file path, or null if it could not. */
  take(index: number): Promise<string | null>;
  /** Release the sidecar. Safe to call more than once. */
  close(): Promise<void>;
}

/** A taker that captures nothing — used when computer use is off. */
export function noShots(): ShotTaker {
  return { take: async () => null, close: async () => {} };
}

/**
 * A taker backed by the screen sidecar.
 *
 * The sidecar is started lazily, on the first click rather than at
 * `:catchthis`, so a recording of pure keyboard work never triggers the
 * portal's consent dialog — which would interrupt the very demonstration it
 * was asked to record.
 */
export function sidecarShots(dir: string): ShotTaker {
  let sidecar: ScreenSidecar | null = null;
  let broken = false;

  return {
    async take(index: number): Promise<string | null> {
      if (broken) return null;
      try {
        if (!sidecar) {
          sidecar = new ScreenSidecar();
          await sidecar.start();
          await sidecar.send({ cmd: 'init' });
        }
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `shot-${String(index).padStart(2, '0')}.png`);
        const reply = await sidecar.send({ cmd: 'capture', path: file }, 15_000);
        if (!reply.ok) return null;
        return file;
      } catch {
        // One failure is enough to stop trying. Retrying per click would put a
        // multi-second stall between every step of the demonstration, which
        // changes the thing being recorded.
        broken = true;
        return null;
      }
    },
    async close(): Promise<void> {
      const s = sidecar;
      sidecar = null;
      try { await s?.stop(); } catch { /* going away regardless */ }
    },
  };
}

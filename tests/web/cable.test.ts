import { describe, it, expect } from 'vitest';
import {
  atRest, cableMidpoint, cablePath, restingSag, springStep, type CableState,
} from '../../web/src/lib/cable.js';

/**
 * The cables are decoration with behaviour, and the behaviour is the part that
 * can actually be wrong: a spring that never settles burns a core forever, and
 * one that diverges makes the cable vanish with no error anywhere.
 */

const run = (target: number, frames = 400, dt = 1 / 60): CableState => {
  let s: CableState = { sag: 0, velocity: 0 };
  for (let i = 0; i < frames; i++) s = springStep(s, target, dt);
  return s;
};

describe('the spring', () => {
  it('settles on its target', () => {
    const s = run(40);
    expect(s.sag).toBeCloseTo(40, 0);
    expect(Math.abs(s.velocity)).toBeLessThan(0.5);
  });

  it('overshoots on the way — that is the wobble', () => {
    // A cable that slides into place looks like an animation. One that
    // overshoots and comes back looks like a cable.
    let s: CableState = { sag: 0, velocity: 0 };
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      s = springStep(s, 40, 1 / 60);
      peak = Math.max(peak, s.sag);
    }
    expect(peak).toBeGreaterThan(40);
  });

  it('survives a tab coming back from the background', () => {
    // A backgrounded tab resumes with a huge delta. One unclamped step through
    // this integrator sends the cable to infinity, which reads as a vanished
    // cable and reports nothing.
    const s = springStep({ sag: 0, velocity: 0 }, 40, 4);
    expect(Number.isFinite(s.sag)).toBe(true);
    expect(Math.abs(s.sag)).toBeLessThan(200);
  });

  it('knows when to stop asking for frames', () => {
    expect(atRest({ sag: 40, velocity: 0 }, 40)).toBe(true);
    expect(atRest({ sag: 0, velocity: 0 }, 40)).toBe(false);
    expect(atRest({ sag: 40, velocity: 30 }, 40)).toBe(false);
  });
});

describe('how far it hangs', () => {
  it('sags more the further it reaches', () => {
    const near = restingSag({ x: 0, y: 0 }, { x: 100, y: 0 });
    const far = restingSag({ x: 0, y: 0 }, { x: 400, y: 0 });
    expect(far).toBeGreaterThan(near);
  });

  it('stops growing, so a board-wide cable stays on the board', () => {
    const huge = restingSag({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(huge).toBeLessThanOrEqual(190);
  });

  it('hangs visibly even across the whole board', () => {
    // Capped too low, a cable spanning four columns reads as a straight
    // diagonal scratch — the exact thing the curve exists to avoid.
    expect(restingSag({ x: 0, y: 0 }, { x: 900, y: 0 })).toBeGreaterThan(90);
  });

  it('hangs less when strung steeply downhill, like a real one', () => {
    const level = restingSag({ x: 0, y: 0 }, { x: 300, y: 0 });
    const steep = restingSag({ x: 0, y: 0 }, { x: 300, y: 400 });
    expect(steep).toBeLessThan(level);
  });

  it('never inverts into an arch', () => {
    expect(restingSag({ x: 0, y: 0 }, { x: 10, y: 2000 })).toBeGreaterThan(0);
  });
});

describe('the drawn path', () => {
  it('starts and ends exactly on the ports', () => {
    const d = cablePath({ x: 10, y: 20 }, { x: 200, y: 60 }, 30);
    expect(d.startsWith('M 10 20')).toBe(true);
    expect(d.endsWith('200 60')).toBe(true);
  });

  it('pulls the control point to twice the sag', () => {
    // A quadratic only reaches halfway to its control point, so without the
    // doubling the cable hangs half as far as asked — which reads as broken
    // physics rather than as a shallow cable.
    const d = cablePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 25);
    expect(d).toContain('Q 50 50');
  });

  it('puts the midpoint where the curve actually passes', () => {
    expect(cableMidpoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 25)).toEqual({ x: 50, y: 25 });
  });
});

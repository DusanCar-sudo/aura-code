/**
 * The cables between linked tiles.
 *
 * A straight line would say the same thing and read as a diagram. These hang
 * and wobble, which does two useful things beyond looking better: a slack cable
 * is obviously a *connection between two objects* rather than a border or a
 * divider, and when a tile is dragged the cable moving with it makes the link
 * something you can feel rather than something you have to notice.
 *
 * The maths is here, apart from React, because it is the part with actual
 * behaviour — a spring that never settles or overshoots into a loop is a real
 * bug, and it should be catchable without a browser.
 */

export interface Point { x: number; y: number }

/** A cable's moving midpoint: where it is, and how fast. */
export interface CableState {
  /** Current sag offset from the straight-line midpoint, in pixels. */
  sag: number;
  /** Rate of change, px/s. Carried between frames — this is what makes it
   *  overshoot and settle rather than slide into place. */
  velocity: number;
}

export interface SpringOptions {
  /** How hard it pulls toward rest. Higher is snappier. */
  stiffness?: number;
  /** How quickly the wobble dies. Higher settles sooner. */
  damping?: number;
}

/** Roughly critically damped, with just enough spring left to be visible. */
const DEFAULTS: Required<SpringOptions> = { stiffness: 120, damping: 14 };

/**
 * How far a cable of this span should hang when it is at rest.
 *
 * Grows with horizontal distance the way a real one does, then stops: a cable
 * spanning the whole board would otherwise sag off the bottom of it. The
 * vertical drop pulls sag *down* a little, because a cable running steeply
 * downhill hangs less than one strung level.
 */
export function restingSag(from: Point, to: Point): number {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const fromSpan = Math.min(dx * 0.22, 70);
  return Math.max(10, fromSpan - dy * 0.06);
}

/**
 * Advance the spring one frame.
 *
 * `dt` is clamped because a backgrounded tab resumes with a huge delta, and a
 * single 4-second step through this integrator sends the cable to infinity —
 * which shows up as a vanished cable and no error anywhere.
 */
export function springStep(
  state: CableState,
  target: number,
  dt: number,
  opts: SpringOptions = {},
): CableState {
  const { stiffness, damping } = { ...DEFAULTS, ...opts };
  const step = Math.min(Math.max(dt, 0), 0.05);
  const force = (target - state.sag) * stiffness - state.velocity * damping;
  const velocity = state.velocity + force * step;
  const sag = state.sag + velocity * step;
  return { sag, velocity };
}

/** True once the cable has stopped moving enough to be worth another frame. */
export function atRest(state: CableState, target: number): boolean {
  return Math.abs(target - state.sag) < 0.3 && Math.abs(state.velocity) < 0.3;
}

/**
 * The SVG path for a cable hanging between two points.
 *
 * A quadratic through a control point below the midpoint. The control point
 * sits at twice the sag because a quadratic curve only reaches halfway to it —
 * without the doubling the cable hangs half as far as asked, which looks like
 * the physics is not working rather than like a shallow cable.
 */
export function cablePath(from: Point, to: Point, sag: number): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} Q ${midX} ${midY + sag * 2} ${to.x} ${to.y}`;
}

/** Where the curve actually passes at its lowest — for placing the arrow. */
export function cableMidpoint(from: Point, to: Point, sag: number): Point {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + sag };
}

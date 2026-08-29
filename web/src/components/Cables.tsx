import { useEffect, useRef, useState } from 'react';
import {
  atRest, cableMidpoint, cablePath, restingSag, springStep, type CableState, type Point,
} from '../lib/cable';
import type { BoardTask } from '../hooks/useBoard';

/**
 * The cables drawn between linked tiles.
 *
 * One SVG stretched over the whole board rather than a line per column,
 * because a cable's whole job is to cross columns — anything clipped to a
 * column would be cut in half at the moment it starts being useful.
 *
 * Positions are measured from the DOM every frame rather than derived from the
 * board state. The tiles are laid out by flexbox inside independently
 * scrolling columns, so their coordinates are not something this component can
 * compute; asking the browser is both simpler and always right.
 */

interface Cable {
  id: string;
  from: Point;
  to: Point;
  sag: number;
  urgent: boolean;
}

/** Whether two frames would draw the same thing, to sub-pixel tolerance. */
function sameCables(a: Cable[], b: Cable[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return c.id === d.id && c.urgent === d.urgent
      && Math.abs(c.from.x - d.from.x) < 0.5 && Math.abs(c.from.y - d.from.y) < 0.5
      && Math.abs(c.to.x - d.to.x) < 0.5 && Math.abs(c.to.y - d.to.y) < 0.5
      && Math.abs(c.sag - d.sag) < 0.5;
  });
}

export function Cables({ tasks, container }: {
  tasks: BoardTask[];
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const [cables, setCables] = useState<Cable[]>([]);
  // Spring state per cable, kept across frames — this is the wobble. A ref
  // rather than state: it changes 60 times a second and nothing renders from
  // it directly.
  const springs = useRef(new Map<string, CableState>());
  const frame = useRef(0);
  const lastTime = useRef(0);

  useEffect(() => {
    const linked = tasks.filter((t) => t.linkedTo);
    if (!linked.length) {
      setCables([]);
      return;
    }

    let running = true;
    // Frames are requested in bursts, not forever. The first version ran the
    // loop continuously and called setState 60 times a second; with several
    // cables that was enough to make the tab unresponsive. Geometry only
    // changes when something moves, so movement is what starts the animation.
    let settleFrames = 0;

    const measure = (id: string): Point | null => {
      const box = container.current;
      const el = box?.querySelector<HTMLElement>(`[data-task-port="${id}"]`);
      if (!box || !el) return null;
      const port = el.getBoundingClientRect();
      const base = box.getBoundingClientRect();
      return {
        x: port.left + port.width / 2 - base.left,
        y: port.top + port.height / 2 - base.top,
      };
    };

    /**
     * Recompute every cable. `dt` of 0 means "place them at rest" — used for
     * the first, synchronous pass.
     */
    const compute = (dt: number) => {

      const next: Cable[] = [];
      let moving = false;

      for (const task of linked) {
        const from = measure(task.id);
        const to = measure(task.linkedTo!);
        // A tile scrolled out of its column has no box worth drawing to. Skip
        // rather than draw to a stale position, which would leave a cable
        // pointing at nothing.
        if (!from || !to) continue;

        const key = `${task.id}->${task.linkedTo}`;
        const target = restingSag(from, to);
        const current = springs.current.get(key) ?? { sag: target, velocity: 0 };
        const stepped = dt > 0 ? springStep(current, target, dt) : { sag: target, velocity: 0 };
        springs.current.set(key, stepped);
        if (dt > 0 && !atRest(stepped, target)) moving = true;

        next.push({
          id: key,
          from,
          to: { x: to.x, y: to.y },
          sag: stepped.sag,
          urgent: task.priority === 'urgent',
        });
      }

      // Only re-render when the picture would actually differ. Without this
      // the settled state still repainted every frame, which is most of what
      // made the tab crawl.
      setCables((prev) => (sameCables(prev, next) ? prev : next));

      return moving;
    };

    const tick = (now: number) => {
      if (!running) return;
      const dt = lastTime.current ? (now - lastTime.current) / 1000 : 1 / 60;
      lastTime.current = now;

      // Keep going while the spring is live, then a few frames more so a cable
      // does not stop one pixel short of rest.
      if (compute(dt)) settleFrames = 6;
      else settleFrames -= 1;

      frame.current = settleFrames > 0 ? requestAnimationFrame(tick) : 0;
    };

    /** Wake the animation — something moved. */
    const wake = () => {
      settleFrames = 6;
      lastTime.current = 0;
      if (!frame.current) frame.current = requestAnimationFrame(tick);
    };

    // Draw them once, right now, before asking for a single frame.
    //
    // requestAnimationFrame does not fire in a tab the browser considers
    // hidden or unfocused, so a cable that only existed once the loop had run
    // simply never appeared there — the link was real, the board knew about
    // it, and the screen showed nothing. The wobble is an enhancement; being
    // visible is not.
    compute(0);
    wake();

    // Tiles move for reasons this component cannot see: a column scrolling, a
    // tile being dragged, the window resizing. Each of those wakes it rather
    // than the loop spinning forever on the chance that one happened.
    window.addEventListener('resize', wake);
    window.addEventListener('scroll', wake, true);
    const box = container.current;
    box?.addEventListener('dragover', wake);
    box?.addEventListener('drop', wake);

    return () => {
      running = false;
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      lastTime.current = 0;
      window.removeEventListener('resize', wake);
      window.removeEventListener('scroll', wake, true);
      box?.removeEventListener('dragover', wake);
      box?.removeEventListener('drop', wake);
    };
  }, [tasks, container]);

  if (!cables.length) return null;

  return (
    <svg className="board-cables" aria-hidden="true">
      {cables.map((c) => {
        const sag = c.sag;
        const mid = cableMidpoint(c.from, c.to, sag);
        return (
          <g key={c.id} className={`cable${c.urgent ? ' cable-urgent' : ''}`}>
            {/* Drawn twice: a soft wide stroke under a sharp one, which reads
                as a cable with a little depth rather than a hairline. */}
            <path className="cable-glow" d={cablePath(c.from, c.to, sag)} />
            <path className="cable-line" d={cablePath(c.from, c.to, sag)} />
            <circle className="cable-bead" cx={mid.x} cy={mid.y} r={3} />
          </g>
        );
      })}
    </svg>
  );
}

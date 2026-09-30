/**
 * The Aura Code brand pieces as terminal art, drawn after the key art:
 * the peak (AuraLogo.kt's path, cream stroke with a gold core), the four
 * slanted stripes, and AURA CODE set in heavy upright capitals.
 */
import chalk from 'chalk';
import { currentTheme, mixHex } from './theme.js';

type Pt = [number, number];

/** The peak path from AuraLogo.kt, in unit coordinates (y down). */
const PEAK_CURVES: [Pt, Pt, Pt, Pt][] = [
  [[0.18, 0.78], [0.27, 0.54], [0.38, 0.29], [0.48, 0.14]],
  [[0.48, 0.14], [0.52, 0.08], [0.58, 0.08], [0.62, 0.14]],
  [[0.62, 0.14], [0.73, 0.31], [0.84, 0.55], [0.93, 0.78]],
  [[0.93, 0.78], [0.77, 0.68], [0.59, 0.63], [0.41, 0.66]],
  [[0.41, 0.66], [0.30, 0.68], [0.23, 0.72], [0.18, 0.78]],
];

function bezier([a, b, c, d]: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
}

const PEAK_POINTS: Pt[] = PEAK_CURVES.flatMap(curve =>
  Array.from({ length: 60 }, (_, i) => bezier(curve, i / 60)));

/** Distance to the path, and whether the nearest point is on the base arc. */
function distToPeak(x: number, y: number): [number, boolean] {
  let best = Infinity, base = false;
  for (let i = 0; i < PEAK_POINTS.length; i++) {
    const [ax, ay] = PEAK_POINTS[i]!;
    const [bx, by] = PEAK_POINTS[(i + 1) % PEAK_POINTS.length]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) { best = d; base = i >= 180; }
  }
  return [best, base];
}

/** Pack a pixel grid (`at(col, row)` → hex or null) into half-block rows. */
function halfBlocks(w: number, h: number, at: (c: number, r: number) => string | null): string[] {
  const rows: string[] = [];
  for (let r = 0; r < h; r += 2) {
    let out = '';
    for (let c = 0; c < w; c++) {
      const up = at(c, r);
      const dn = r + 1 < h ? at(c, r + 1) : null;
      if (!up && !dn) out += ' ';
      else if (up && dn && up === dn) out += chalk.hex(up)('█');
      else if (up && dn) out += chalk.hex(up).bgHex(dn)('▀');
      else if (up) out += chalk.hex(up)('▀');
      else out += chalk.hex(dn!)('▄');
    }
    rows.push(out);
  }
  return rows;
}

/**
 * The peak, `size` pixels square (size columns, size/2 rows before trimming
 * empty rows). Cream body with a thin gold core and a faint gold glow; `k`
 * fades it in from the background.
 */
export function peakRows(size: number, k = 1): string[] {
  const t = currentTheme().tokens as Record<string, string>;
  const bg = t.bg, body = t.fg, core = t.accent;
  const rim = mixHex(bg, body, 0.3);
  const at = (c: number, r: number): string | null => {
    const [d, base] = distToPeak((c + 0.5) / size, (r + 0.5) / size);
    // Cream stroke with a dark rim; the base arc carries the gold (launcher icon).
    const hex = d <= 0.04 ? (base && d <= 0.025 ? core : body)
      : d <= 0.065 ? rim : null;
    return hex && mixHex(bg, hex, k);
  };
  return halfBlocks(size, size, at).filter(row => row.trim() !== '');
}

/** Heavy upright capitals, 7×8 pixels (4 text rows). */
const GLYPHS: Record<string, string[]> = {
  A: ['..###..', '.#####.', '##...##', '##...##', '#######', '#######', '##...##', '##...##'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  R: ['######.', '#######', '##...##', '#######', '######.', '##.##..', '##..##.', '##...##'],
  C: ['.######', '#######', '##.....', '##.....', '##.....', '##.....', '#######', '.######'],
  O: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  D: ['######.', '#######', '##...##', '##...##', '##...##', '##...##', '#######', '######.'],
  E: ['#######', '#######', '##.....', '######.', '######.', '##.....', '#######', '#######'],
  ' ': ['...', '...', '...', '...', '...', '...', '...', '...'],
};
const GLYPH_H = 8;

/** A word in the heavy capitals; `ink(y)` colours pixel row y (0 = top), null hides it. */
export function wordmarkLines(text: string, ink: (y: number) => string | null): string[] {
  const grid: string[] = Array.from({ length: GLYPH_H }, () => '');
  [...text.toUpperCase()].forEach((ch, i) => {
    const g = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let y = 0; y < GLYPH_H; y++) grid[y] += (i ? '.' : '') + g[y];
  });
  const w = grid[0]!.length;
  return halfBlocks(w, GLYPH_H, (c, r) => (grid[r]![c] === '#' ? ink(r) : null));
}

export function wordmarkWidth(text: string): number {
  return [...text.toUpperCase()].reduce((n, ch, i) => n + (i ? 1 : 0) + (GLYPHS[ch] ?? GLYPHS[' ']!)[0]!.length, 0);
}

/** Cream at the top to straw at the foot, as on the key art. */
export function creamInk(k = 1): (y: number) => string {
  const t = currentTheme().tokens as Record<string, string>;
  return (y: number) => mixHex(t.bg, mixHex(t.fg, t.soft, y / (GLYPH_H - 1) * 0.7), k);
}

export const STRIPES = ['#e4312b', '#f8b91e', '#2fae4e', '#1aa6e0'];

/**
 * The four stripes as one slanted band: each colour three cells wide, the
 * joins cut on the diagonal with ▟. Stripes past `lit` show in `unlit`.
 */
export function stripeBar(lit = 4, unlit = '#333'): string {
  const hexes = STRIPES.map((hex, i) => (i < lit ? hex : unlit));
  let out = chalk.hex(hexes[0]!)('▟██');
  for (let i = 1; i < 4; i++) out += chalk.hex(hexes[i]!).bgHex(hexes[i - 1]!)('▟') + chalk.hex(hexes[i]!)('██');
  return out + chalk.hex(hexes[3]!)('▛');
}
export const STRIPE_BAR_WIDTH = 13;

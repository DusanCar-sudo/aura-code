import chalk from 'chalk';
import { peakRows, wordmarkLines, wordmarkWidth, creamInk, stripeBar } from './wordmark.js';
import { currentTheme, mixHex, type ThemeToken } from './theme.js';

// Every colour here is read from the active theme at load (default: Nature —
// forest ground, cream text, gold light; BRAND.md §5.2). The export names are
// the pre-theme ones, kept because the rest of the CLI imports them.
export function tokenHex(token: ThemeToken | string): string {
  const t = currentTheme().tokens as Record<string, string>;
  return t[token as string] ?? '#f2f1f5';
}

/** The one accent per surface — gold on Nature. Used for the message-bubble bar. */
export const RUBY_HEX = tokenHex('accent');
export const RUBY_ACCENT = chalk.hex(RUBY_HEX);

export const BG_HEX = tokenHex('bg');
export const PANEL_BG_HEX = tokenHex('panelBg');
/** Tool/UI chrome — "the tooling talking to you". */
export const TERRACOTTA_HEX = tokenHex('chrome');
export const TEXT_HEX = tokenHex('fg');
export const TEXT_DIM_HEX = tokenHex('dim');
export const FAINT_HEX = tokenHex('faint');
export const TEXT = chalk.hex(TEXT_HEX);
export const TEXT_DIM = chalk.hex(TEXT_DIM_HEX);
export const FAINT = chalk.hex(FAINT_HEX);
export const CHROME_DIM = chalk.hex(tokenHex('chromeDim'));

/** Four stops, dark → bright, for rules, borders and dividers. */
const GRADIENT_HEXES = currentTheme().gradient;
const GRADIENT_STOPS = GRADIENT_HEXES.map(hex => chalk.hex(hex));

/**
 * Color a run of identical border/rule characters with the four-stop ruby
 * gradient, dark → bright, split into four roughly equal segments across
 * its length. Works for horizontal rules ('─'.repeat(n)) and is also used
 * character-by-character for vertical dividers (see `gradientRows`).
 */
export function gradient(str: string): string {
  const len = str.length;
  if (len === 0) return str;
  const segLen = Math.max(1, Math.ceil(len / GRADIENT_STOPS.length));
  let out = '';
  let i = 0;
  for (const stop of GRADIENT_STOPS) {
    if (i >= len) break;
    out += stop(str.slice(i, i + segLen));
    i += segLen;
  }
  return out;
}

/** Bold variant of `gradient()` — for borders that need extra visual weight (e.g. the input box, where the user types). */
export function gradientBold(str: string): string {
  const len = str.length;
  if (len === 0) return str;
  const segLen = Math.max(1, Math.ceil(len / GRADIENT_STOPS.length));
  let out = '';
  let i = 0;
  for (const stop of GRADIENT_STOPS) {
    if (i >= len) break;
    out += stop.bold(str.slice(i, i + segLen));
    i += segLen;
  }
  return out;
}

/**
 * Color for the Nth row (0-indexed) of a `total`-row vertical divider —
 * dark at the top, bright at the bottom, same four stops as `gradient()`.
 * Used to color a single divider character ('│') per output row.
 */
export function gradientStopFor(row: number, total: number): chalk.Chalk {
  const idx = Math.min(GRADIENT_STOPS.length - 1, Math.floor((row / Math.max(1, total)) * GRADIENT_STOPS.length));
  return GRADIENT_STOPS[idx];
}

/**
 * The Aura mark: lowercase "aura" and the four Sinclair stripes, from the
 * ∞K retro identity (aura-retro-design, brand/glyphs.py). One glyph unit is
 * one pixel — 10-unit x-height, 3-unit stroke — and each text row carries two
 * pixel rows as half blocks, so the mark prints 5 rows × 59 columns. `#` is
 * letter ink; `r y g c` are the stripes, which lean one pixel every two rows
 * so that no cell ever needs two colours. The counters are square: at this
 * size a round one reads as a "+".
 */
const MARK_PIXELS: string[] = [
  '...#######..###....###..#######......#######.......rryyggcc',
  '.#########..###....###..#########..#########.......rryyggcc',
  '.#########..###....###..#########..#########......rryyggcc.',
  '###....###..###....###..####......###....###......rryyggcc.',
  '###....###..###....###..###.......###....###.....rryyggcc..',
  '###....###..###....###..###.......###....###.....rryyggcc..',
  '###....###..###....###..###.......###....###....rryyggcc...',
  '.#########...#########..###........#########....rryyggcc...',
  '.#########...#########..###........#########...rryyggcc....',
  '...#######.....#######..###..........#######...rryyggcc....',
];
const MARK_WIDTH = 12 + 3 + wordmarkWidth('AURA CODE');
/** The mark's text rows, plus the "CODE" row under the stripes. */
const LOCKUP_ROWS = MARK_PIXELS.length / 2 + 1;

/**
 * The stripe colours, in Sinclair order. Fixed, not themed: they are the
 * logo, and they read on dark and light grounds alike.
 */
const STRIPE_HEXES: Record<string, string> = {
  r: '#e4312b', y: '#f8b91e', g: '#2fae4e', c: '#1aa6e0',
};

/**
 * The glow ramp for the motto: near-white into the theme accent.
 */
const GLOW_STOPS = [mixHex(RUBY_HEX, '#ffffff', 0.85), mixHex(RUBY_HEX, '#ffffff', 0.5), RUBY_HEX, mixHex(RUBY_HEX, BG_HEX, 0.2)] as const;

export interface BannerInfo {
  version: string;
  title?: string;
  model?: string;
  provider?: string;
  language?: string;
  mode?: string;
  cwd?: string;
  extras?: string[];
}

/** Clear the screen and move the cursor to the top-left (home). */
export function clearToTop(): void {
  // \x1b[2J clears the screen, \x1b[3J wipes scrollback, \x1b[H homes cursor.
  // Matches how Claude Code pins its header at the top on launch.
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function hexToRgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/**
 * Sample a color ramp at `t` (0 → first stop, 1 → last), interpolating
 * between the two stops it falls between. Unlike `gradient()`, which paints
 * in four hard segments, this is continuous — the banner's artwork needs a
 * smooth falloff, not visible banding.
 */
function ramp(stops: readonly string[], t: number): chalk.Chalk {
  const scaled = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return chalk.rgb(
    Math.round(a.r + (b.r - a.r) * f),
    Math.round(a.g + (b.g - a.g) * f),
    Math.round(a.b + (b.b - a.b) * f),
  );
}

/** A terracotta-gradient horizontal rule, `width` characters wide. */
function chromeRule(width: number): string {
  return Array.from({ length: Math.max(1, width) }, (_, i) =>
    ramp(GRADIENT_HEXES, i / Math.max(1, width - 1))('─')).join('');
}

/** A rule spanning the full terminal width — the banner's closing edge. */
function fullRule(): string {
  return chromeRule(Math.max(10, process.stdout.columns ?? 80));
}

/* ── the lockup, rasterized from the brand geometry ─────────────────────────
 * Ported from aura-retro-design brand/glyphs.py: fat rounded "aura" (rings +
 * rects, x-height 10, stroke 3), the four leaning stripes, small caps "CODE"
 * under the stripes. Sampled twice per terminal row (upper/lower half block)
 * so the round bowls survive. y is up, like the brand source.
 */
type LockupPrim =
  | { k: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { k: 'ring'; cx: number; cy: number; ri: number; ro: number; a0: number; a1: number };

const ringP = (cx: number, cy: number, ri: number, ro: number, a0 = 0, a1 = 360): LockupPrim => ({ k: 'ring', cx, cy, ri, ro, a0, a1 });
const rectP = (x0: number, y0: number, x1: number, y1: number): LockupPrim => ({ k: 'rect', x0, y0, x1, y1 });

function glyphA(x: number): LockupPrim[] { return [ringP(x + 5, 5, 2, 5), rectP(x + 7, 0, x + 10, 10)]; }
function glyphU(x: number): LockupPrim[] { return [rectP(x, 5, x + 3, 10), ringP(x + 5, 5, 2, 5, 180, 360), rectP(x + 7, 0, x + 10, 10)]; }
function glyphR(x: number): LockupPrim[] { return [rectP(x, 0, x + 3, 10), ringP(x + 5, 5, 2, 5, 32, 180)]; }

const STRIPE_W = 2.4, STRIPE_SLANT = 5, STRIPE_GAP = 2.6, CODE_SCALE = 0.6;

function wordmarkPrims(): { prims: LockupPrim[]; width: number } {
  const prims: LockupPrim[] = [];
  let x = 0;
  prims.push(...glyphA(x)); x += 10 + 1.8;
  prims.push(...glyphU(x)); x += 10 + 1.8;
  prims.push(...glyphR(x)); x += 5 + 5 * Math.cos(32 * Math.PI / 180) + 1.3;
  prims.push(...glyphA(x)); x += 10;
  return { prims, width: x };
}

function inPrim(p: LockupPrim, x: number, y: number): boolean {
  if (p.k === 'rect') return x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1;
  const r = Math.hypot(x - p.cx, y - p.cy);
  if (r < p.ri || r > p.ro) return false;
  const span = p.a1 - p.a0;
  if (span >= 360) return true;
  let a = Math.atan2(y - p.cy, x - p.cx) * 180 / Math.PI;
  if (a < 0) a += 360;
  const a0 = ((p.a0 % 360) + 360) % 360;
  return ((a - a0) % 360 + 360) % 360 <= span;
}

function stripeAt(i: number, sx0: number, x: number, y: number): boolean {
  const bx = sx0 + i * STRIPE_W;
  const shift = STRIPE_SLANT * (y / 10);
  return y >= 0 && y <= 10 && x >= bx + shift && x <= bx + STRIPE_W + shift;
}

function scalePrim(p: LockupPrim, s: number, dx: number, dy: number): LockupPrim {
  if (p.k === 'rect') return { k: 'rect', x0: dx + p.x0 * s, y0: dy + p.y0 * s, x1: dx + p.x1 * s, y1: dy + p.y1 * s };
  return { k: 'ring', cx: dx + p.cx * s, cy: dy + p.cy * s, ri: p.ri * s, ro: p.ro * s, a0: p.a0, a1: p.a1 };
}

function codeCapPrims(): { prims: LockupPrim[]; width: number } {
  const C = 2.2;
  const capC = (x: number): LockupPrim[] => [ringP(x + 5, 5, 5 - C, 5, 45, 315)];
  const capO = (x: number): LockupPrim[] => [ringP(x + 5, 5, 5 - C, 5, 0, 360)];
  const capD = (x: number): LockupPrim[] => [rectP(x, 0, x + C, 10), rectP(x, 0, x + 5, C), rectP(x, 10 - C, x + 5, 10), ringP(x + 5, 5, 5 - C, 5, -90, 90)];
  const capE = (x: number): LockupPrim[] => [rectP(x, 0, x + C, 10), rectP(x, 10 - C, x + 8, 10), rectP(x, 5 - C / 2, x + 7, 5 + C / 2), rectP(x, 0, x + 8, C)];
  const prims: LockupPrim[] = [];
  let x = 0;
  for (const [fn, w] of [[capC, 5 + 5 * Math.cos(45 * Math.PI / 180)], [capO, 10], [capD, 10], [capE, 8]] as [(x: number) => LockupPrim[], number][]) {
    for (const q of fn(x)) prims.push(scalePrim(q, CODE_SCALE, 0, 0));
    x += w + 3.2;
  }
  return { prims, width: x - 3.2 };
}

/** Letter ink by height (y is up, 10 = top of the x-height); stripes lit left to right. */
export interface LockupPaint {
  letter?: (y: number) => string | null;
  lit?: number;
  unlit?: string;
}

function sampleColor(x: number, y: number, wm: LockupPrim[], sx0: number, code: LockupPrim[], paint: LockupPaint): string | null {
  const lit = paint.lit ?? 4;
  for (let i = 0; i < 4; i++) {
    if (stripeAt(i, sx0, x, y)) return i < lit ? STRIPE_HEXES[['r', 'y', 'g', 'c'][i]] : (paint.unlit ?? FAINT_HEX);
  }
  const ink = paint.letter ? paint.letter(y) : TEXT_HEX;
  if (!ink) return null;
  for (const p of wm) if (inPrim(p, x, y)) return ink;
  for (const p of code) if (inPrim(p, x, y)) return ink;
  return null;
}

function markLines(paint: LockupPaint = {}): string[] {
  const wm = wordmarkPrims();
  const sx0 = wm.width + STRIPE_GAP;
  const end = sx0 + 4 * STRIPE_W + STRIPE_SLANT;
  /* fit the terminal: condense horizontally rather than clip or wrap */
  const termCols = process.stdout.columns ?? Number(process.env.COLUMNS) ?? 80;
  const sx = Math.min(1, (termCols - 2) / end);
  const caps = codeCapPrims();
  const capsH = 10 * CODE_SCALE;
  const codeDy = 0.4 - capsH;          /* caps' top just under the stripes' foot */
  const code = caps.prims.map(q => scalePrim(q, 1, (end - caps.width * CODE_SCALE) * sx, codeDy));
  const cols = Math.ceil(end * sx) + 1;
  const rows: string[] = [];
  const bottom = -4;
  for (let rowTop = 10; rowTop >= -4; rowTop -= 2) {   /* past the caps' foot so nothing clips */
    let out = '';
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) / sx;   /* sample the unscaled geometry */
      const up = sampleColor(x, rowTop - 0.5, wm.prims, sx0, code, paint);
      const dn = sampleColor(x, rowTop - 1.5, wm.prims, sx0, code, paint);
      if (!up && !dn) { out += ' '; continue; }
      if (up && dn && up === dn) { out += chalk.hex(up)('█'); continue; }
      if (up && dn) { out += chalk.hex(up).bgHex(dn)('▀'); continue; }
      if (up && !dn) { out += chalk.hex(up)('▀'); continue; }
      out += chalk.hex(dn as string)('▄');
    }
    rows.push(out.replace(/\s+$/, ''));
  }
  return rows;
}

/** The rasterized lockup is the whole mark — stripes and CODE included. */
export function lockupLines(paint?: LockupPaint): string[] {
  if (paint) return markLines(paint);
  // Key-art lockup: the peak beside AURA CODE, stripes under the word.
  const peak = peakRows(12);
  const word = [...wordmarkLines('AURA CODE', creamInk()), '', stripeBar()];
  const h = Math.max(peak.length, word.length);
  const po = Math.floor((h - peak.length) / 2);
  const out: string[] = [];
  for (let i = 0; i < h; i++) {
    const p = peak[i - po] ?? ' '.repeat(12);
    out.push((p + '   ' + (word[i] ?? '')).replace(/\s+$/, ''));
  }
  return out;
}

/** The stripes alone in one text row: each ▟ in the next colour on the one before. */
function stripeRun(): string {
  const [r, y, g, c] = ['r', 'y', 'g', 'c'].map(k => STRIPE_HEXES[k]);
  return chalk.hex(r)('▟') + chalk.hex(y).bgHex(r)('▟') + chalk.hex(g).bgHex(y)('▟')
    + chalk.hex(c).bgHex(g)('▟') + chalk.hex(c)('▘');
}

// ── Banner ──────────────────────────────────────────────────────────────────

/** Visible width of a styled string, ignoring SGR escapes. */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * `hero` sets the session card beside the mark and needs a terminal that can
 * hold both; `standard` stacks the card under it; `compact` is a single
 * line, for narrow terminals and for the TUI's pinned header, where every
 * banner row is permanently subtracted from the scroll region.
 */
export type BannerTier = 'hero' | 'standard' | 'compact';

const TAGLINE = 'praktess · she who acts and executes';
/** Indent, mark, gutter and bar, then the version + tagline line beside it. */
const HERO_MIN_COLS = 2 + MARK_WIDTH + 6 + 'v00.00.00   '.length + TAGLINE.length;  // 115
const HERO_MIN_ROWS = 24;  // the mark greets you without being the whole view

/** The largest tier the current terminal has room for. */
export function preferredBannerTier(): BannerTier {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 0;
  if (cols >= HERO_MIN_COLS && rows >= HERO_MIN_ROWS) return 'hero';
  if (cols >= MARK_WIDTH + 4) return 'standard';
  return 'compact';
}

/** The session facts, one per line: what model, what mode, where. */
function metaLines(info: BannerInfo): string[] {
  const sep = FAINT(' · ');
  return [
    [info.provider && chalk.hex(TERRACOTTA_HEX)(info.provider), info.model && TEXT(info.model)]
      .filter(Boolean).join(sep),
    [
      info.mode && TEXT_DIM(`${info.mode} mode`),
      info.language && TEXT_DIM(info.language),
      ...(info.extras ?? []).map(e => FAINT(e)),
    ].filter(Boolean).join(sep),
    [info.title && TEXT_DIM(info.title), FAINT(info.cwd ?? process.cwd())]
      .filter(Boolean).join(sep),
  ].filter(line => visibleWidth(line) > 0);
}

function versionLine(info: BannerInfo): string {
  return chalk.hex(TERRACOTTA_HEX).bold(`v${info.version}`) + FAINT(`   ${TAGLINE}`);
}

const MOTTO = ramp(GLOW_STOPS, 0.2)('"I don\'t try. I verify."');

/**
 * Mark on the left; version, session facts and motto on the right, behind
 * a terracotta bar and centered against the mark.
 */
function heroLines(info: BannerInfo): string[] {
  const mark = lockupLines();
  const card = [versionLine(info), ...metaLines(info), MOTTO];
  const height = Math.max(mark.length, card.length);
  const cardOffset = Math.floor((height - card.length) / 2);

  const lines = [''];
  for (let i = 0; i < height; i++) {
    const markRow = mark[i] ?? '';
    const gutter = ' '.repeat(MARK_WIDTH - visibleWidth(markRow) + 3);
    const bar = ramp(GRADIENT_HEXES, i / Math.max(1, height - 1))('│');
    const cardRow = card[i - cardOffset] ?? '';
    lines.push(('  ' + markRow + gutter + bar + '  ' + cardRow).replace(/\s+$/, ''));
  }
  lines.push('');
  lines.push(fullRule());
  return lines;
}

/** The mark, then the card under it: rule, version/tagline, facts, motto. */
function standardLines(info: BannerInfo): string[] {
  const card = [
    ...lockupLines(),
    '',
    chromeRule(MARK_WIDTH),
    versionLine(info),
    '',
    ...metaLines(info),
    '',
    MOTTO,
  ];
  return ['', ...card.map(line => (line ? '  ' + line : '')), fullRule()];
}

/**
 * One line, for narrow terminals and for the TUI's pinned header: the mark
 * as "aura", one row of stripes and "CODE". Fields are appended only while
 * they fit: at this size the mark has to survive, the model name is the next
 * most useful thing to know, and everything after that is a bonus.
 */
function compactLines(info: BannerInfo): string[] {
  const width = Math.max(10, process.stdout.columns ?? 80);
  let line = TEXT.bold('AURA') + ' ' + stripeRun() + ' ' + TEXT.bold('CODE');
  let used = 2 + 'AURA ▟▟▟▟▘ CODE'.length;

  for (const [gap, part, plain] of [
    ['  ', FAINT(`v${info.version}`), `v${info.version}`],
    [' · ', info.model && TEXT(info.model), info.model ?? ''],
    [' · ', info.mode && TEXT_DIM(`${info.mode} mode`), `${info.mode} mode`],
  ] as [string, string | undefined, string][]) {
    if (!part || used + gap.length + plain.length > width) continue;
    line += (gap === '  ' ? gap : FAINT(gap)) + part;
    used += gap.length + plain.length;
  }
  return ['', '  ' + line, fullRule()];
}

/**
 * The banner's fully-styled lines, one string per terminal row. Exposed
 * separately from renderBanner() so the TUI can keep a copy and repaint the
 * banner itself when it rebuilds the screen (e.g. returning from scroll
 * mode) — the alt screen has no scrollback to recover it from.
 *
 * Pass a tier to override the terminal-size fit; the TUI pins `compact`
 * because its banner rows cost scroll region for the whole session.
 */
export function buildBannerLines(info: BannerInfo, tier: BannerTier = preferredBannerTier()): string[] {
  if (tier === 'hero') return heroLines(info);
  if (tier === 'standard') return standardLines(info);
  return compactLines(info);
}

/** Render the banner pinned to the top of a cleared screen, so it reads like a real app header, not scrollback. */
export function renderBanner(info: BannerInfo, tier?: BannerTier): void {
  clearToTop();
  buildBannerLines(info, tier).forEach(line => console.log(line));
}

/** The mark alone, centered — splash contexts with nothing else to say. */
export function renderMark(): void {
  const indent = Math.max(0, Math.floor(((process.stdout.columns ?? 80) - MARK_WIDTH) / 2));
  const pad = ' '.repeat(indent);
  console.log('');
  lockupLines().forEach(row => console.log(pad + row));
  console.log('');
}

/** Standalone stub for the old gem API (nothing renders now; the mark is the splash). */
export function renderDiamond(): void {
  console.log('');
}

export const CHROME = chalk.hex(tokenHex('chrome'));
export const SOFT = chalk.hex(tokenHex('soft'));
export const CYAN = chalk.hex(tokenHex('cyan'));
export const FG_BRIGHT = chalk.hex(tokenHex('fgBright'));
export const CODE_BG = chalk.bgHex(tokenHex('panelBg'));
export const OK = chalk.hex(tokenHex('ok'));
export const WARN = chalk.hex(tokenHex('warn'));
export const ERR = chalk.hex(tokenHex('err'));
export const INFO = chalk.hex(tokenHex('info'));

import chalk from 'chalk';

// Ruby palette — matches https://dusancar-sudo.github.io/aura-website/
// (#e63956 bright ruby, #9b1b30 primary, #4a0d1a deep wine)
const ruby = chalk.hex('#9b1b30');

// Primary ruby as a single reusable accent (e.g. the message-bubble left
// bar) — distinct from the 4-stop gradient, which is for dividers/borders.
export const RUBY_HEX = '#9b1b30';
export const RUBY_ACCENT = ruby;

// ── Palette v3: bluish-dark background, terracotta chrome, white text ──────
// Terminal background, set via OSC 11 on TUI start (desaturated dark navy).
export const BG_HEX = '#0f1724';
// Elevated panel background (code/log blocks) — one step lighter than BG_HEX.
export const PANEL_BG_HEX = '#1c2739';
// Tool/UI chrome — the terracotta already used for tool labels and mode
// indicators across the CLI. Everything that is "the tooling talking to you".
export const TERRACOTTA_HEX = '#cc785c';
// Primary text (user input, assistant replies, body copy) — near-white for
// maximum readability on the bluish background.
export const TEXT_HEX = '#e8e6e3';
// Secondary/de-emphasized text — desaturated blue-gray, quieter than TEXT_HEX
// but still readable on BG_HEX.
export const TEXT_DIM_HEX = '#8a94a6';
// Faintest text (rules, timings, ellipses) — visible but receding on BG_HEX.
export const FAINT_HEX = '#4a5568';
export const TEXT = chalk.hex(TEXT_HEX);
export const TEXT_DIM = chalk.hex(TEXT_DIM_HEX);
export const FAINT = chalk.hex(FAINT_HEX);
// Muted terracotta for unfocused/quiet chrome (e.g. blurred panel borders).
export const CHROME_DIM = chalk.hex('#8a5a48');

/**
 * The four terracotta stops, dark end → bright end, centered on
 * TERRACOTTA_HEX. Used for every line that separates fields/panels/sections
 * (box borders, rules, column dividers) — per the fixed palette rule,
 * dividers get this same four-stop gradient rather than a single flat hue.
 * (The ruby stops remain for accents and the banner motto.)
 */
const GRADIENT_HEXES = ['#7a4636', '#a05a44', TERRACOTTA_HEX, '#e29a80'] as const;
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
const MARK_WIDTH = 59;
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
 * The glow ramp for the motto: white-hot through hot ruby to the brand ruby.
 * It bottoms out at RUBY_HEX rather than the deep wine so it stays legible
 * against BG_HEX.
 */
const GLOW_STOPS = ['#fff3f5', '#ffc2cd', '#ff7d92', '#ee4463', '#cc2846', RUBY_HEX] as const;

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

/**
 * Print the mark: each pair of pixel rows becomes one text row of half
 * blocks, with runs of same-coloured cells painted in one go. Letters take
 * TEXT; stripe cells are always full blocks, since both of their pixel rows
 * share a shift.
 */
function markLines(): string[] {
  const lines: string[] = [];
  for (let y = 0; y < MARK_PIXELS.length; y += 2) {
    const top = MARK_PIXELS[y];
    const bottom = MARK_PIXELS[y + 1];
    let out = '';
    let run = '';
    let runInk = '.';
    const flush = () => {
      if (run) out += runInk === '.' ? run : runInk === '#' ? TEXT(run) : chalk.hex(STRIPE_HEXES[runInk])(run);
      run = '';
    };
    for (let x = 0; x < MARK_WIDTH; x++) {
      const t = top[x];
      const b = bottom[x];
      const ink = t !== '.' ? t : b;
      const cell = t === '.' && b === '.' ? ' ' : t === '.' ? '▄' : b === '.' ? '▀' : '█';
      if (ink !== runInk) { flush(); runInk = ink; }
      run += cell;
    }
    flush();
    lines.push(out.replace(/\s+$/, ''));
  }
  return lines;
}

/**
 * The mark with "CODE" set under the stripes, spread across them from their
 * foot to their top edge, the way the lockup has it.
 */
function lockupLines(): string[] {
  const stripeStart = MARK_PIXELS[MARK_PIXELS.length - 1].search(/[rygc]/);
  return [...markLines(), ' '.repeat(stripeStart + 1) + TEXT.bold('C  O  D  E')];
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

const MOTTO = ramp(GLOW_STOPS, 0.2).italic('"I don\'t try. I verify."');

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
  let line = TEXT.bold('aura') + ' ' + stripeRun() + ' ' + TEXT.bold('CODE');
  let used = 2 + 'aura ▟▟▟▟▘ CODE'.length;

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

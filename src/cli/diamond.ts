import chalk from 'chalk';

// Ruby palette — matches https://aurawebsite-self.vercel.app/
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
 * (The ruby stops above remain for the mark/wordmark branding only.)
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
 * The Aura mark: a burst struck through a vertical axis — the shape of a
 * beacon that has just been lit. Hand-drawn at 47×22 and used only at that
 * size: the ray texture is carried by single characters, so any downscale
 * (box-filtering 2×2 cells into one) collapses it into noise. The narrower
 * banner tiers therefore drop the mark rather than shrink it.
 */
const MARK: string[] = [
  '           .              #@#              .',
  '           .*             :@=             *:',
  '            ##.           :@=           .##.',
  '            *##:          :@=          .###',
  '         *. =###-    #*=--***=-=*#.   :###+  +',
  '         =#= +###=       :@:@-       -###* =#+',
  '          *##:.###+      :@:@-      =###:.###',
  '          =####:*##*     .@:@-     +##*.*###=',
  '        ==. =###*-###    .@:@-    *##=+###+  -+',
  '         :##+ :###+###.  .@:@:   *##+###- +##-',
  '          .####+:*#####. .@:@: .#####*:+####:',
  '         :   .-###*=###* .%.#: *###+*###=.   :',
  '          :*###*+-=+###+  .*.. +###+=-=*###*:',
  '             :-=+######*  *##  *######*=-:',
  '              :-+###**##:##-##.##**###+-:',
  '                   =*#*=##. .##++#*+',
  '                      :###= -###-',
  '                     -#* -###= *#-',
  '                      =   *.#   -',
  '                          *:#',
  '                          ==+',
  '                          .+:',
];
const MARK_WIDTH = 47;
/** The mark's optical center: the axis column, and the burst core — which
 *  sits above the geometric middle, since the tail hangs below it. */
const MARK_CX = 27;
const MARK_CY = 9;

/**
 * The mark's glow ramp, core → tips: white-hot at the strike point, through
 * hot ruby, out to the brand ruby at the ray ends. It bottoms out at
 * RUBY_HEX rather than the deep wine so the outermost rays stay legible
 * against BG_HEX.
 */
const GLOW_STOPS = ['#fff3f5', '#ffc2cd', '#ff7d92', '#ee4463', '#cc2846', RUBY_HEX] as const;

/**
 * How much ink each glyph of the mark carries. The art shades itself by
 * character weight; feeding that back into the color ramp keeps the drawn
 * highlights bright instead of flattening them under the radial falloff.
 */
const INK: Record<string, number> = {
  '@': 1, '%': 0.95, '#': 0.85, '*': 0.6, '+': 0.45,
  '=': 0.4, '-': 0.28, ':': 0.22, '.': 0.12,
};

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
 * Light the mark: distance from the burst core drives the ramp, and each
 * glyph's ink weight biases it back toward the bright end, so the drawn
 * highlights survive the falloff. Terminal cells are about twice as tall
 * as they are wide, hence the doubled vertical term.
 */
function shadeMark(): string[] {
  const maxR = Math.hypot(MARK_CX, MARK_CY * 2);
  return MARK.map((row, y) => {
    let out = '';
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ') { out += ' '; continue; }
      const radial = Math.min(1, Math.pow(Math.hypot(x - MARK_CX, (y - MARK_CY) * 2) / maxR, 0.85) * 1.15);
      out += ramp(GLOW_STOPS, Math.min(1, radial * 0.72 + (1 - (INK[ch] ?? 0.5)) * 0.28))(ch);
    }
    return out;
  });
}

// ── Wordmark ────────────────────────────────────────────────────────────────
// 5×5 block capitals — the only letterforms in the app drawn as artwork
// rather than text. AURA carries the ruby (the brand), CODE the terracotta
// (the tooling), per the palette split used everywhere else in the CLI.
const GLYPHS: Record<string, string[]> = {
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  C: [' ███ ', '█    ', '█    ', '█    ', ' ███ '],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
};
const WORDMARK_ROWS = 5;
/** "AURA" + three-column word gap + "CODE", both at 5×5 with 1-column tracking. */
const WORDMARK_WIDTH = 23 * 2 + 3;

/** Paint one word's rows with `stops` swept from `t0` (left) to `t1` (right). */
function shadeWord(text: string, stops: readonly string[], t0: number, t1: number): string[] {
  const rows = Array.from({ length: WORDMARK_ROWS }, () => '');
  const width = text.length * 6 - 1;
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    for (let r = 0; r < WORDMARK_ROWS; r++) {
      const cells = (i ? ' ' : '') + glyph[r];
      const originX = i * 6 - (i ? 1 : 0);
      for (let c = 0; c < cells.length; c++) {
        rows[r] += cells[c] === ' '
          ? ' '
          : ramp(stops, t0 + (t1 - t0) * ((originX + c) / (width - 1))).bold(cells[c]);
      }
    }
  });
  return rows;
}

function wordmarkLines(): string[] {
  const aura = shadeWord('AURA', GLOW_STOPS, 0.25, 0.68);
  const code = shadeWord('CODE', GRADIENT_HEXES, 0.85, 0.3);
  return aura.map((row, i) => row + '   ' + code[i]);
}

// ── Banner ──────────────────────────────────────────────────────────────────

/** Visible width of a styled string, ignoring SGR escapes. */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * `hero` is the full lockup (mark + wordmark + session card) and needs a
 * terminal that can actually hold it; `standard` drops the mark; `compact`
 * is a single line, for narrow terminals and for the TUI's pinned header,
 * where every banner row is permanently subtracted from the scroll region.
 */
export type BannerTier = 'hero' | 'standard' | 'compact';

const HERO_MIN_COLS = MARK_WIDTH + WORDMARK_WIDTH + 4;  // 100
const HERO_MIN_ROWS = MARK.length + 8;                  // room left to work in

/** The largest tier the current terminal has room for. */
export function preferredBannerTier(): BannerTier {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 0;
  if (cols >= HERO_MIN_COLS && rows >= HERO_MIN_ROWS) return 'hero';
  if (cols >= WORDMARK_WIDTH + 4) return 'standard';
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

/** Wordmark, rule, version/tagline, session facts, motto — the right column. */
function cardLines(info: BannerInfo): string[] {
  return [
    ...wordmarkLines(),
    '',
    chromeRule(WORDMARK_WIDTH),
    chalk.hex(TERRACOTTA_HEX).bold(`v${info.version}`)
      + FAINT('   praktess · she who acts and executes'),
    '',
    ...metaLines(info),
    '',
    ramp(GLOW_STOPS, 0.2).italic('"I don\'t try. I verify."'),
  ];
}

/** Mark on the left, card on the right, card centered against the mark. */
function heroLines(info: BannerInfo): string[] {
  const mark = shadeMark();
  const card = cardLines(info);
  const height = Math.max(mark.length, card.length);
  const cardOffset = Math.floor((height - card.length) / 2);

  const lines = [''];
  for (let i = 0; i < height; i++) {
    const markRow = i < mark.length ? mark[i] : '';
    const gutter = ' '.repeat(MARK_WIDTH - (i < MARK.length ? MARK[i].length : 0) + 2);
    const cardRow = card[i - cardOffset] ?? '';
    lines.push((' ' + markRow + gutter + cardRow).replace(/\s+$/, ''));
  }
  lines.push('');
  lines.push(fullRule());
  return lines;
}

function standardLines(info: BannerInfo): string[] {
  return ['', ...cardLines(info).map(line => (line ? '  ' + line : '')), fullRule()];
}

/**
 * One line, for narrow terminals and for the TUI's pinned header. Fields are
 * appended only while they fit: at this size the wordmark has to survive, the
 * model name is the next most useful thing to know, and everything after that
 * is a bonus.
 */
function compactLines(info: BannerInfo): string[] {
  const width = Math.max(10, process.stdout.columns ?? 80);
  let line = ramp(GLOW_STOPS, 0.1).bold('AURA') + ' ' + chalk.hex(TERRACOTTA_HEX).bold('CODE');
  let used = 2 + 'AURA CODE'.length;

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
  shadeMark().forEach(row => console.log(pad + row));
  console.log('');
}

/** Standalone stub for the old gem API (nothing renders now; the mark is the splash). */
export function renderDiamond(): void {
  console.log('');
}

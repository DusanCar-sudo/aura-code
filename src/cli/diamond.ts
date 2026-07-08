import chalk from 'chalk';

// Ruby palette — matches https://aurawebsite-self.vercel.app/
// (#e63956 bright ruby, #9b1b30 primary, #4a0d1a deep wine)
const light  = chalk.hex('#e63956');
const mid    = chalk.hex('#c22743');
const ruby   = chalk.hex('#9b1b30');
const shadow = chalk.hex('#6d1322');

// Primary ruby as a single reusable accent (e.g. the message-bubble left
// bar) — distinct from the 4-stop gradient, which is for dividers/borders.
export const RUBY_HEX = '#9b1b30';
export const RUBY_ACCENT = ruby;

// Body/UI text (task output, command list, panel labels) — exact hex per
// design direction: #8c7662.
export const GOLD_HEX = '#8c7662';
// Muted variant for secondary/de-emphasized text — #8c7662 scaled ~28% darker,
// same hue, quieter than GOLD_HEX.
export const GOLD_DIM_HEX = '#655547';
export const GOLD = chalk.hex(GOLD_HEX);
export const GOLD_DIM = chalk.hex(GOLD_DIM_HEX);
const dim = GOLD_DIM;

/**
 * The four ruby stops, dark end → bright end. Used for every line that
 * separates fields/panels/sections (box borders, rules, column dividers) —
 * per the fixed palette rule, dividers get this same four-stop gradient
 * rather than a single flat hue.
 */
const GRADIENT_STOPS = [shadow, ruby, mid, light] as const;

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
 * Brilliant-cut gem, 9 rows: a narrow flat table, a widening crown, the
 * wide girdle (row 4, the widest point), then a long tapering pavilion
 * down to a single point — the silhouette of an actual cut diamond, not
 * a symmetric kite or a wedge. Solid blocks only (no fractional glyphs)
 * so the point renders cleanly on every terminal font; per-row 3D facet
 * shading is applied at render time by styleGemRow, not baked in here.
 */
export const GEM = [
  '   █████    ', // table
  '  ████████  ', // crown
  ' ██████████ ', // crown → girdle
  '████████████', // girdle (widest)
  ' █████████  ', // pavilion
  '  ███████   ', // pavilion
  '   █████    ', // pavilion
  '    ███     ', // pavilion, narrowing to the point
  '     █      ', // point
];

/** Column width of one gem row (all rows share the same padded width). */
export const GEM_WIDTH = GEM[0].length;

/** The gem's styled Nth row, or null if out of range — for compositing beside other columns. */
export function gemRow(i: number): string | null {
  const row = GEM[i];
  return row === undefined ? null : styleGemRow(row, FACET_SHADES);
}

const LOGO = [
  ' ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░ ░▒▓██████▓▒░         ░▒▓██████▓▒░  ▒▓██████▓▒░░▒▓███████▓▒░░ ▒▓████████▓ ',
  '░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ▒▓█▓▒░      ',
  '░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░░▒▓█▓▒░▒▓█▓▒░      ',
  '░▒▓████████▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░░▒▓████████▓▒░       ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░░▒▓█▓▒░▒▓██████▓▒  ',
  '░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░░▒▓█▓▒░▒▓█▓▒░      ',
  '░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ▒▓█▓▒░      ',
  '░▒▓█▓▒░░▒▓█▓▒░░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░        ░▒▓██████▓▒░ ░▒▓██████▓▒░░▒▓███████▓▒░░ ▒▓████████▓ ',
];

// Shade zones for 3D faceted diamond: [leftFace, midFace, shadowFace].
// Light comes from top-left, so left face is brightest.
const FACET_SHADES = [light, mid, shadow] as const;

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

/** A ruby-gradient horizontal rule spanning the terminal width (capped). */
function rule(): string {
  const width = Math.min(process.stdout.columns ?? 80, 100);
  return gradient('─'.repeat(width));
}

/**
 * Apply 3D faceted lighting to a diamond row: bright → mid → shadow across
 * the width of its solid-block run (three-zone split, 40/35/25).
 */
function styleGemRow(row: string, shades: readonly chalk.Chalk[]): string {
  const match = row.match(/([█]+)/);
  if (!match) return row;

  const blockStr = match[1];
  const blockIdx = match.index!;
  const len = blockStr.length;

  const leftLen  = Math.max(1, Math.ceil(len * 0.40));
  const midLen   = Math.max(1, Math.ceil(len * 0.35));
  const rightLen = Math.max(0, len - leftLen - midLen);

  let styled = '';
  if (leftLen > 0)  styled += shades[0](blockStr.slice(0, leftLen));
  if (midLen > 0)   styled += shades[1](blockStr.slice(leftLen, leftLen + midLen));
  if (rightLen > 0) styled += shades[2](blockStr.slice(leftLen + midLen));

  return row.slice(0, blockIdx) + styled + row.slice(blockIdx + len);
}

/** The gem's styled rows, centered above whatever text follows them. */
function gemBlockLines(indent: number): string[] {
  const pad = ' '.repeat(Math.max(0, indent));
  return GEM.map(row => pad + styleGemRow(row, FACET_SHADES));
}

/** Render the gem alone, centered above whatever text follows it. */
function renderGemBlock(indent: number): void {
  gemBlockLines(indent).forEach(line => console.log(line));
}

/**
 * The banner's fully-styled lines, one string per terminal row:
 * - Brilliant-cut gem centered above the wordmark, each row faceted
 *   left-bright / mid / shadow (light hits from the top-left).
 * - LOGO text gets a left-bright / right-shadow treatment.
 * - Session metadata (version, provider/model, cwd, tagline) below.
 * Exposed separately from renderBanner() so the TUI can keep a copy and
 * repaint the banner itself when it rebuilds the screen (e.g. returning
 * from scroll mode) — the alt screen has no scrollback to recover it from.
 */
export function buildBannerLines(info: BannerInfo): string[] {
  const lines: string[] = [''];

  const gemIndent = Math.floor((LOGO[0].length - GEM[0].length) / 2);
  lines.push(...gemBlockLines(gemIndent), '');

  LOGO.forEach(row => {
    const midPoint = Math.floor(row.length / 2);
    lines.push(light(row.slice(0, midPoint)) + shadow(row.slice(midPoint)));
  });

  lines.push('');

  const meta = [
    info.provider,
    info.model,
    info.language,
    info.mode && `${info.mode} mode`,
    ...(info.extras ?? []),
  ].filter(Boolean).join(' · ');

  lines.push('  ' + ruby.bold(`v${info.version}`) + (info.title ? dim(` — ${info.title}`) : ''));
  if (meta) lines.push('  ' + dim(meta));
  lines.push('  ' + dim(info.cwd ?? process.cwd()));
  lines.push('  ' + light.italic('"I don\'t try. I verify."'));
  lines.push(rule());
  return lines;
}

/** Render the banner pinned to the top of a cleared screen, so it reads like a real app header, not scrollback. */
export function renderBanner(info: BannerInfo): void {
  clearToTop();
  buildBannerLines(info).forEach(line => console.log(line));
}

/** Standalone diamond (no logo, no info column) — splash contexts. */
export function renderDiamond(): void {
  console.log('');
  renderGemBlock(2);
  console.log('');
}

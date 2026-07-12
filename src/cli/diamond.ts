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
const dim = TEXT_DIM;

/**
 * The four terracotta stops, dark end → bright end, centered on
 * TERRACOTTA_HEX. Used for every line that separates fields/panels/sections
 * (box borders, rules, column dividers) — per the fixed palette rule,
 * dividers get this same four-stop gradient rather than a single flat hue.
 * (The ruby stops above remain for the gem/logo branding only.)
 */
const chromeShadow = chalk.hex('#7a4636');
const chromeMid    = chalk.hex('#a05a44');
const chromeBase   = chalk.hex(TERRACOTTA_HEX);
const chromeLight  = chalk.hex('#e29a80');
const GRADIENT_STOPS = [chromeShadow, chromeMid, chromeBase, chromeLight] as const;

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
export const GEM: string[] = [];

export const GEM_WIDTH = 0;

export function gemRow(i: number): string | null {
  return null;
}

const LOGO = [
  '                                     ██▓▒▒                                      ',
  '                                    ███▓▒▒▒                                     ',
  ' █████╗ ██╗   ██╗██████╗  █████╗   ████▓▒▒▒▒    ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔══██╗██║   ██║██╔══██╗██╔══██╗ █████▓▒▒▒▒▒  ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '███████║██║   ██║██████╔╝███████║  ████▓▒▒▒▒   ██║     ██║   ██║██║  ██║█████╗  ',
  '██╔══██║██║   ██║██╔══██╗██╔══██║   ███▓▒▒▒    ██║     ██║   ██║██║  ██║██╔══╝  ',
  '██║  ██║╚██████╔╝██║  ██║██║  ██║    ██▓▒▒     ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝     █▓▒       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
  '                                       ▓                                        '
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

const logoColors = ['#ff8c00', '#ff1493', '#dc143c', '#6d1322'];

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function styleLogoRow(str: string): string {
  if (str.length === 0) return str;
  let out = '';
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const progress = i / Math.max(1, len - 1);
    const scaled = progress * (logoColors.length - 1);
    const index = Math.floor(scaled);
    const factor = scaled - index;
    
    if (index >= logoColors.length - 1) {
      out += chalk.hex(logoColors[logoColors.length - 1]).bold(str[i]);
    } else {
      const c1 = hexToRgb(logoColors[index]);
      const c2 = hexToRgb(logoColors[index + 1]);
      const r = Math.round(c1.r + (c2.r - c1.r) * factor);
      const g = Math.round(c1.g + (c2.g - c1.g) * factor);
      const b = Math.round(c1.b + (c2.b - c1.b) * factor);
      out += chalk.rgb(r, g, b).bold(str[i]);
    }
  }
  return out;
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
  // Push 3 empty strings to move the logo down by 2 extra rows from the top edge
  const lines: string[] = ['', '', ''];

  if (GEM && GEM.length > 0) {
    const gemIndent = Math.floor((LOGO[0].length - GEM[0].length) / 2);
    lines.push(...gemBlockLines(gemIndent), '');
  }

  LOGO.forEach(row => {
    // Add 2 spaces for left padding
    lines.push('  ' + styleLogoRow(row));
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

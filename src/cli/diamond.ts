import chalk from 'chalk';

// Ruby palette — matches https://aurawebsite-self.vercel.app/
// (#e63956 bright ruby, #9b1b30 primary, #4a0d1a deep wine)
const light  = chalk.hex('#e63956');
const mid    = chalk.hex('#c22743');
const ruby   = chalk.hex('#9b1b30');
const shadow = chalk.hex('#6d1322');
const dim    = chalk.hex('#8a7768');

/**
 * Brilliant-cut gem, 9 rows: a narrow flat table, a widening crown, the
 * wide girdle (row 4, the widest point), then a long tapering pavilion
 * down to a single point — the silhouette of an actual cut diamond, not
 * a symmetric kite or a wedge. Solid blocks only (no fractional glyphs)
 * so the point renders cleanly on every terminal font; per-row 3D facet
 * shading is applied at render time by styleGemRow, not baked in here.
 */
const GEM = [
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

/** A ruby horizontal rule spanning the terminal width (capped). */
function rule(): string {
  const width = Math.min(process.stdout.columns ?? 80, 100);
  return shadow('─'.repeat(width));
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

/** Render the gem alone, centered above whatever text follows it. */
function renderGemBlock(indent: number): void {
  const pad = ' '.repeat(Math.max(0, indent));
  GEM.forEach(row => console.log(pad + styleGemRow(row, FACET_SHADES)));
}

/**
 * Render the banner:
 * - Brilliant-cut gem centered above the wordmark, each row faceted
 *   left-bright / mid / shadow (light hits from the top-left).
 * - LOGO text gets a left-bright / right-shadow treatment.
 * - Session metadata (version, provider/model, cwd, tagline) below,
 *   pinned to the top of a cleared screen so it reads like a real app
 *   header, not scrollback.
 */
export function renderBanner(info: BannerInfo): void {
  clearToTop();
  console.log('');

  const gemIndent = Math.floor((LOGO[0].length - GEM[0].length) / 2);
  renderGemBlock(gemIndent);
  console.log('');

  LOGO.forEach(row => {
    const midPoint = Math.floor(row.length / 2);
    const leftSide  = row.slice(0, midPoint);
    const rightSide = row.slice(midPoint);
    console.log(light(leftSide) + shadow(rightSide));
  });

  console.log('');

  const meta = [
    info.provider,
    info.model,
    info.language,
    info.mode && `${info.mode} mode`,
    ...(info.extras ?? []),
  ].filter(Boolean).join(' · ');

  console.log('  ' + ruby.bold(`v${info.version}`) + (info.title ? dim(` — ${info.title}`) : ''));
  if (meta) console.log('  ' + dim(meta));
  console.log('  ' + dim(info.cwd ?? process.cwd()));
  console.log('  ' + light.italic('"I don\'t try. I verify."'));
  console.log(rule());
}

/** Standalone diamond (no logo, no info column) — splash contexts. */
export function renderDiamond(): void {
  console.log('');
  renderGemBlock(2);
  console.log('');
}

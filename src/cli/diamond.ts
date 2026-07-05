import chalk from 'chalk';

// Ruby palette — matches https://aurawebsite-self.vercel.app/
// (#e63956 bright ruby, #9b1b30 primary, #4a0d1a deep wine)
const light  = chalk.hex('#e63956');
const mid    = chalk.hex('#c22743');
const ruby   = chalk.hex('#9b1b30');
const shadow = chalk.hex('#6d1322');
const dim    = chalk.hex('#8a7768');

// Gem: flat top table, monotonically narrowing straight down to a single
// point. No widen-then-narrow bulge (that reads as a heart, not a gem).
// Solid blocks only — no fractional glyphs — so the point renders cleanly
// on every terminal font.
const GEM = [
'  ██████████  ',
'██████████████',
' ████████████ ',
'  ██████████  ',
'   ████████   ',
'    ██████    ',
'     ████     ',
'      ██      ',
];

const LOGO = [
' ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░ ░▒▓██████▓▒░         ░▒▓██████▓▒░  ▒▓██████▓▒░░▒▓███████▓▒░░ ▒▓████████▓ ',
'░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ▒▓█▓▒░      ',
'░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░░▒▓█▓▒░▒▓█▓▒░      ',
'░▒▓████████▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░░▒▓████████▓▒░       ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░░▒▓█▓▒░▒▓██████▓▒  ',
'░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░░▒▓█▓▒░▒▓█▓▒░      ',
'░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░       ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ▒▓█▓▒░      ',
'░▒▓█▓▒░░▒▓█▓▒░░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░        ░▒▓██████▓▒░ ░▒▓██████▓▒░░▒▓███████▓▒░░ ▒▓████████▓ '
];

// Gradient across the 7 LOGO/GEM rows: bright ruby at top fading to deep wine.
const LOGO_SHADES = [light, light, mid, mid, ruby, ruby, shadow];
const GEM_SHADES  = [light, light, mid, mid, ruby, ruby, shadow];

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
 * Full startup banner: big ASCII "AURA CODE" logo in a ruby gradient,
 * with the gem beside it, session info, and a rule — pinned to the top
 * of a cleared screen so it reads like a real app header, not scrollback.
 */
export function renderBanner(info: BannerInfo): void {
  const gemPadding = ' '.repeat(GEM[0].length + 2);

  clearToTop();
  console.log('');
  LOGO.forEach((row, i) => {
    const gemPart = GEM[i] ? '  ' + GEM_SHADES[i](GEM[i]) : gemPadding;
    console.log(LOGO_SHADES[i](row) + gemPart);
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

/** Standalone diamond (no info column) — splash contexts. */
export function renderDiamond(): void {
  console.log('');
  GEM.forEach((row, i) => console.log('  ' + GEM_SHADES[i](row)));
  console.log('');
}

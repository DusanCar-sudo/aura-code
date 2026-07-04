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

/**
 * Full startup banner: big ASCII "AURA CODE" logo in a ruby gradient,
 * with the gem beside it, followed by session info.
 */
export function renderBanner(info: BannerInfo): void {
  const gemPadding = ' '.repeat(GEM[0].length + 2);

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
  console.log('');
}

/** Standalone diamond (no info column) — splash contexts. */
export function renderDiamond(): void {
  console.log('');
  GEM.forEach((row, i) => console.log('  ' + GEM_SHADES[i](row)));
  console.log('');
}

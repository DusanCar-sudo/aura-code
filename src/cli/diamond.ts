import chalk from 'chalk';

// Ruby palette — matches https://aurawebsite-self.vercel.app/
// (#e63956 bright ruby, #9b1b30 primary, #4a0d1a deep wine)
const light  = chalk.hex('#e63956');
const mid    = chalk.hex('#c22743');
const ruby   = chalk.hex('#9b1b30');
const shadow = chalk.hex('#6d1322');
const ivory  = chalk.hex('#f0ece4');
const dim    = chalk.hex('#8a7768');

// Brilliant-cut gem, top-lit: flat table, faceted crown, pavilion to a point.
const GEM = [
  ' ▗█████▖ ',
  ' ▝▜███▛▘ ',
  '  ▝▜█▛▘  ',
  '    ▀    ',
];
const SHADES = [light, mid, ruby, shadow];

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

/** Claude Code–style startup banner: diamond logo left, session info right. */
export function renderBanner(info: BannerInfo): void {
  const meta = [
    info.provider,
    info.model,
    info.language,
    info.mode && `${info.mode} mode`,
    ...(info.extras ?? []),
  ].filter(Boolean).join(' · ');

  const lines = [
    ivory.bold(`Aura Code v${info.version}`) + (info.title ? dim(` — ${info.title}`) : ''),
    dim(meta),
    dim(info.cwd ?? process.cwd()),
    light.italic('"I don\'t try. I verify."'),
  ];

  console.log('');
  GEM.forEach((row, i) => {
    console.log('  ' + SHADES[i](row) + '  ' + (lines[i] ?? ''));
  });
  console.log('');
}

/** Standalone diamond (no info column) — splash contexts. */
export function renderDiamond(): void {
  console.log('');
  GEM.forEach((row, i) => console.log('  ' + SHADES[i](row)));
  console.log('');
}

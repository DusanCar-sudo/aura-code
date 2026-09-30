/**
 * The launch splash — the terminal twin of Aura Droid's BrandSplash.kt
 * (BRAND.md §13): the peak on forest, the two-beat tagline, the four stripes
 * lighting in order, and the big lockup in the cream-to-olive gradient.
 *
 * About 1.5 s (900 ms animation + 650 ms hold), once per interactive launch;
 * any key skips it. It never delays start-up on purpose beyond that, and it is
 * off whenever the terminal can't show it properly.
 */
import chalk from 'chalk';
import { BG_HEX, TEXT_HEX, TEXT_DIM_HEX, tokenHex } from './diamond.js';
import { peakRows, stripeBar, wordmarkLines, creamInk } from './wordmark.js';
import { mixHex } from './theme.js';

const ANIM_MS = 900;
const HOLD_MS = 650;
const FRAME_MS = 60;
function visible(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** One frame at progress p ∈ [0, 1], centred in cols × rows. */
function frame(p: number, cols: number, rows: number, peakSize: number): string {
  const peakK = clamp01(p / 0.35);
  const tagK = clamp01((p - 0.3) / 0.3);
  const markK = clamp01((p - 0.45) / 0.4);
  const lit = Math.floor(clamp01((p - 0.4) / 0.5) * 4 + 1e-6);

  const tagA = 'Your coding agent, ';
  const tagB = 'in your pocket.';
  const tag1 = tagK === 0 ? '' : chalk.hex(mixHex(BG_HEX, TEXT_HEX, tagK)).bold(tagA.trim());
  const tag2 = tagK === 0 ? '' : chalk.hex(mixHex(BG_HEX, tokenHex('soft'), tagK)).bold(tagB);

  const stripes = stripeBar(lit, mixHex(BG_HEX, TEXT_DIM_HEX, 0.2));
  const ink = creamInk(markK);
  const word = wordmarkLines('AURA CODE', y => (markK === 0 ? null : ink(y)));

  const block = [...peakRows(peakSize, peakK), '', tag1, tag2, '', stripes, '', '', ...word];
  const top = Math.max(0, Math.floor((rows - block.length) / 2));
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = block[i - top] ?? '';
    const pad = ' '.repeat(Math.max(0, Math.floor((cols - visible(line)) / 2)));
    lines.push('\x1b[2K' + pad + line);
  }
  return '\x1b[H' + lines.join('\r\n');
}

/** True when this terminal should get the splash. */
export function splashWanted(): boolean {
  const env = process.env;
  if (env.AURA_NO_SPLASH || env.NO_COLOR || env.CI || env.TERM === 'dumb') return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  const cols = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  return cols >= 72 && rows >= 22;
}

/** Play the splash, then clear the screen. Resolves early on any key. */
export async function runSplash(): Promise<void> {
  if (!splashWanted()) return;
  const out = process.stdout;
  const stdin = process.stdin;
  const cols = out.columns ?? 80;
  const rows = out.rows ?? 24;
  // peak + stripes + tagline + wordmark must fit: about 12 rows besides the peak.
  const peakSize = Math.max(14, Math.min(30, 2 * (rows - 16)) & ~1);
  const reduced = !!process.env.AURA_REDUCED_MOTION;

  let skipped = false;
  let wake: (() => void) | null = null;
  const onKey = (buf: Buffer): void => {
    if (buf[0] === 3) { restore(); process.exit(130); }
    skipped = true;
    wake?.();
  };
  const wasRaw = stdin.isRaw;
  const restore = (): void => {
    stdin.removeListener('data', onKey);
    try { stdin.setRawMode(wasRaw); } catch { /* not a tty anymore */ }
    stdin.pause();
    out.write('\x1b[2J\x1b[3J\x1b[H\x1b[?25h');
  };
  const sleep = (ms: number): Promise<void> => new Promise(res => {
    if (skipped) return res();
    const t = setTimeout(() => { wake = null; res(); }, ms);
    wake = () => { clearTimeout(t); wake = null; res(); };
  });

  try { stdin.setRawMode(true); } catch { return; }
  stdin.resume();
  stdin.on('data', onKey);

  out.write(`\x1b]11;${BG_HEX}\x07\x1b[?25l\x1b[2J`);
  try {
    if (reduced) {
      out.write(frame(1, cols, rows, peakSize));
      await sleep(500);
    } else {
      const start = Date.now();
      for (;;) {
        const p = clamp01((Date.now() - start) / ANIM_MS);
        out.write(frame(p, cols, rows, peakSize));
        if (p >= 1 || skipped) break;
        await sleep(FRAME_MS);
      }
      await sleep(HOLD_MS);
    }
  } finally {
    restore();
  }
}

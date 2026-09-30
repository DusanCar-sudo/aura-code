/**
 * Themes — the TUI's palette, in the Aura adOS theme format.
 *
 * adOS keeps a theme as a flat `key=value` file plus the *name* of the active
 * one: `~/.config/aura/theme` holds e.g. `gruvbox`, and the palette itself is
 * at `~/.config/aura/themes/gruvbox.conf` (the generated form) or in the OS
 * source tree as `~/aura-os/themes/gruvbox/palette`. This module reads both of
 * those formats, so every theme the OS ships is a theme the TUI can wear, and
 * the seven adOS tokens — BG, SURFACE, LINE, FG, DIM, ACCENT, ACCENT2 — are the
 * spine of the palette here too.
 *
 * Two things are added, because a terminal UI needs more than seven colours:
 *
 *  1. The other slots (ok / warn / err / info, cyan, ruby) come from the richer
 *     `palette` format adOS's own theme directories use, and are *derived* from
 *     the seven when a theme does not name them.
 *  2. `nature` — the Aura Droid palette, forest/cream/gold — is built in and
 *     is the default; `violet-dusk`, the TUI's original navy, stays available.
 *
 * Active theme resolution:
 *
 *   $AURA_THEME  →  ~/.aura/theme  →  nature
 *
 * `~/.aura/theme` is aura-code's own file, written by `:theme <name>`, so a
 * `:theme` choice never rewrites the OS's theme; `:theme sync` copies adOS's
 * current pick into it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Every colour slot the TUI can paint with. */
export type ThemeToken =
  | 'bg' | 'bgAlt' | 'panelBg' | 'line'
  | 'fg' | 'fgBright' | 'dim' | 'faint' | 'soft'
  | 'chrome' | 'chromeDim'
  | 'accent' | 'accent2'
  | 'ok' | 'warn' | 'err' | 'info' | 'cyan' | 'ruby';

export const THEME_TOKENS: readonly ThemeToken[] = [
  'bg', 'bgAlt', 'panelBg', 'line',
  'fg', 'fgBright', 'dim', 'faint', 'soft',
  'chrome', 'chromeDim',
  'accent', 'accent2',
  'ok', 'warn', 'err', 'info', 'cyan', 'ruby',
];

export interface Theme {
  id: string;
  /** Display name — the adOS `NAME=` when the file carries one. */
  name: string;
  /** Light themes need a light terminal background (OSC 11) and light fallbacks. */
  dark: boolean;
  font: string | undefined;
  radius: string | undefined;
  /** 'built-in', or the path of the file the theme was read from. */
  source: string;
  tokens: Record<ThemeToken, string>;
  /** Four dark→bright stops for rules, borders and the banner. */
  gradient: [string, string, string, string];
}

// ── Colour maths ───────────────────────────────────────────────────────────

function parseHex(value: string): [number, number, number] | null {
  const v = value.trim().replace(/^["']|["']$/g, '').replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) {
    return [
      parseInt(v[0] + v[0], 16),
      parseInt(v[1] + v[1], 16),
      parseInt(v[2] + v[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(v)) {
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ];
  }
  return null;
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}

/** Blend `a` toward `b`; t=0 gives `a`, t=1 gives `b`. Non-hex input returns `a`. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.max(0, Math.min(1, t));
  return toHex([
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k,
  ]);
}

/** Darken (amt < 0) or lighten (amt > 0) a colour toward black / white. */
export function shadeHex(hex: string, amt: number): string {
  return amt >= 0 ? mixHex(hex, '#ffffff', amt) : mixHex(hex, '#000000', -amt);
}

/** Perceived brightness, 0–1. Drives the light/dark guess when a file is silent. */
export function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const [r, g, b] = c.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type PartialTokens = Partial<Record<ThemeToken, string>>;

/**
 * Fill a partial palette out to all nineteen tokens. Returns null when there is
 * no `bg` — a file without a background is not a theme.
 *
 * The derivations are the ones that keep a seven-colour adOS theme legible in a
 * terminal: `soft` is the warm in-between used for numbers in reports, and the
 * faint/chromeDim ends are mixed toward `bg` so they recede rather than glow.
 */
export function expandTokens(partial: PartialTokens): Record<ThemeToken, string> | null {
  const bg = partial.bg;
  if (!bg || !parseHex(bg)) return null;

  const fg = partial.fg ?? (luminance(bg) > 0.4 ? '#2b2b33' : '#e8e6e3');
  const chrome = partial.chrome ?? partial.accent ?? fg;
  const dim = partial.dim ?? mixHex(fg, bg, 0.55);

  return {
    bg,
    bgAlt: partial.bgAlt ?? mixHex(bg, fg, 0.06),
    panelBg: partial.panelBg ?? partial.bgAlt ?? mixHex(bg, fg, 0.06),
    line: partial.line ?? mixHex(bg, fg, 0.14),
    fg,
    fgBright: partial.fgBright ?? mixHex(fg, luminance(bg) > 0.4 ? '#000000' : '#ffffff', 0.35),
    dim,
    faint: partial.faint ?? mixHex(dim, bg, 0.45),
    soft: partial.soft ?? mixHex(fg, chrome, 0.32),
    chrome,
    chromeDim: partial.chromeDim ?? mixHex(chrome, bg, 0.5),
    accent: partial.accent ?? chrome,
    accent2: partial.accent2 ?? mixHex(chrome, fg, 0.25),
    ok: partial.ok ?? '#5a9e6e',
    warn: partial.warn ?? '#d4903a',
    err: partial.err ?? '#b15439',
    info: partial.info ?? '#6ed0ea',
    cyan: partial.cyan ?? partial.info ?? '#3fb9d8',
    ruby: partial.ruby ?? '#9b1b30',
  };
}

function deriveGradient(tokens: Record<ThemeToken, string>): [string, string, string, string] {
  const c = tokens.chrome;
  return [mixHex(c, tokens.bg, 0.45), mixHex(c, tokens.bg, 0.2), c, mixHex(c, '#ffffff', 0.25)];
}

function makeTheme(
  id: string,
  name: string,
  partial: PartialTokens,
  opts: { source?: string; font?: string; radius?: string; dark?: boolean; gradient?: [string, string, string, string] } = {},
): Theme | null {
  const tokens = expandTokens(partial);
  if (!tokens) return null;
  return {
    id,
    name,
    dark: opts.dark ?? luminance(tokens.bg) <= 0.4,
    font: opts.font,
    radius: opts.radius,
    source: opts.source ?? 'built-in',
    tokens,
    gradient: opts.gradient ?? deriveGradient(tokens),
  };
}

// ── Built-ins ──────────────────────────────────────────────────────────────
// `nature` first: the shared Aura palette and the default. The rest mirror the
// themes adOS ships.

const VIOLET_DUSK_GRADIENT: [string, string, string, string] = ['#7a4636', '#a05a44', '#cc785c', '#e29a80'];

const NATURE_GRADIENT: [string, string, string, string] = ['#535c37', '#9a8a4f', '#e7cf85', '#f2ebc9'];
const NATURE_CREAM_GRADIENT: [string, string, string, string] = ['#b9ba9f', '#8b8e7a', '#535c37', '#3b4232'];

const BUILTINS: Theme[] = [
  // Nature — the Aura Droid palette (BRAND.md §5.2): forest ground, cream text, gold light.
  makeTheme('nature', 'Nature', {
    bg: '#070907', bgAlt: '#0c100c', panelBg: '#141a14', line: '#23291f',
    fg: '#f2ebc9', fgBright: '#fffaf0', dim: '#b9baa2', faint: '#8b8e7a', soft: '#d8cb95',
    chrome: '#e7cf85', chromeDim: '#77704a', accent: '#e7cf85', accent2: '#d8cb95',
    ok: '#3cc45e', warn: '#f8b91e', err: '#f0584f', info: '#6ed0ea', cyan: '#1aa6e0', ruby: '#d24b30',
  }, { dark: true, gradient: NATURE_GRADIENT }),

  makeTheme('nature-cream', 'Nature Cream', {
    bg: '#f2ebc9', bgAlt: '#e9e1bb', panelBg: '#e2dbb7', line: '#cfc6a0',
    fg: '#10150f', fgBright: '#000000', dim: '#3b4232', faint: '#6b6f58', soft: '#535c37',
    chrome: '#535c37', chromeDim: '#8b8e7a', accent: '#535c37', accent2: '#3b4232',
    ok: '#1f7a37', warn: '#8a6200', err: '#b3261e', info: '#0f6f96', cyan: '#0f6f96', ruby: '#9b1b30',
  }, { dark: false, gradient: NATURE_CREAM_GRADIENT }),

  makeTheme('violet-dusk', 'Violet Dusk', {
    bg: '#0f1724', bgAlt: '#131c2b', panelBg: '#1c2739', line: '#263349',
    fg: '#e8e6e3', fgBright: '#ffffff', dim: '#8a94a6', faint: '#4a5568', soft: '#c8b5a0',
    chrome: '#cc785c', chromeDim: '#8a5a48', accent: '#cc785c', accent2: '#9b1b30',
    ok: '#5a9e6e', warn: '#d4903a', err: '#b15439', info: '#6ed0ea', cyan: '#3fb9d8', ruby: '#9b1b30',
  }, { dark: true, gradient: VIOLET_DUSK_GRADIENT }),

  makeTheme('gruvbox', 'Gruvbox', {
    bg: '#1d2021', bgAlt: '#282828', line: '#3c3836',
    fg: '#ebdbb2', fgBright: '#fbf1c7', dim: '#665c54', faint: '#504945',
    chrome: '#fe8019', accent: '#fe8019', accent2: '#fabd2f',
    ok: '#b8bb26', warn: '#fabd2f', err: '#fb4934', info: '#83a598', cyan: '#8ec07c', ruby: '#cc241d',
  }, { dark: true }),

  makeTheme('nord', 'Nord', {
    bg: '#2e3440', bgAlt: '#3b4252', line: '#434c5e',
    fg: '#d8dee9', fgBright: '#eceff4', dim: '#616e88', faint: '#4c566a',
    chrome: '#88c0d0', accent: '#88c0d0', accent2: '#8fbcbb',
    ok: '#a3be8c', warn: '#ebcb8b', err: '#bf616a', info: '#81a1c1', cyan: '#88c0d0', ruby: '#bf616a',
  }, { dark: true }),

  makeTheme('tokyo-night', 'Tokyo Night', {
    bg: '#1a1b26', bgAlt: '#1f2335', line: '#292e42',
    fg: '#c0caf5', fgBright: '#e0e6ff', dim: '#565f89', faint: '#414868',
    chrome: '#7aa2f7', accent: '#7aa2f7', accent2: '#89b4fa',
    ok: '#9ece6a', warn: '#e0af68', err: '#f7768e', info: '#7aa2f7', cyan: '#7dcfff', ruby: '#f7768e',
  }, { dark: true }),

  makeTheme('purplerain', 'Purplerain', {
    bg: '#0e0e14', bgAlt: '#14141e', line: '#2a2a3a',
    fg: '#c8cad8', fgBright: '#e6e8f2', dim: '#5c5f77', faint: '#3f4054',
    chrome: '#8b7cf6', accent: '#8b7cf6', accent2: '#a594f9',
    ok: '#83e6a0', warn: '#f9e2af', err: '#f38ba8', info: '#6ea8fe', cyan: '#5de4c7', ruby: '#f38ba8',
  }, { dark: true }),

  makeTheme('matrix', 'Matrix', {
    bg: '#000000', bgAlt: '#0a0a0a', line: '#1a1a1a',
    fg: '#00ff00', fgBright: '#00ff00', dim: '#008800', faint: '#004400',
    chrome: '#00ff00', accent: '#00ff00', accent2: '#00cc00',
    ok: '#00ff00', warn: '#ffff00', err: '#ff0000', info: '#00ffff', cyan: '#00ffff', ruby: '#ff0000',
  }, { dark: true }),
  makeTheme('mono', 'Mono', {
    bg: '#000000', bgAlt: '#111111', line: '#333333',
    fg: '#d0d0d0', fgBright: '#ffffff', dim: '#666666', faint: '#444444',
    chrome: '#ffffff', accent: '#ffffff', accent2: '#ffffff',
    ok: '#5fd75f', warn: '#d7d75f', err: '#ff5f5f', info: '#5f87d7', cyan: '#5fd7d7', ruby: '#ff5f5f',
  }, { dark: true }),

  makeTheme('paper', 'Paper', {
    bg: '#f5f3ee', bgAlt: '#ebe8e0', line: '#cfcac0',
    fg: '#2b2b33', fgBright: '#000000', dim: '#8a8680', faint: '#b3aea4',
    chrome: '#6a4cd8', accent: '#6a4cd8', accent2: '#5638c9',
    ok: '#2e8b57', warn: '#b8860b', err: '#c0392b', info: '#2f6fd8', cyan: '#138d90', ruby: '#c0392b',
  }, { dark: false }),

  makeTheme('neon-day', 'Neon Day', {
    bg: '#f7f7fb', bgAlt: '#eceaf6', line: '#d3cfeb',
    fg: '#1b1730', fgBright: '#000000', dim: '#6f6a8f', faint: '#a9a3c0',
    chrome: '#c2185b', accent: '#c2185b', accent2: '#7b1fa2',
    ok: '#2e7d32', warn: '#b26a00', err: '#c62828', info: '#1565c0', cyan: '#00838f', ruby: '#c62828',
  }, { dark: false }),
].filter((t): t is Theme => t !== null);

// ── Theme files ────────────────────────────────────────────────────────────

/** adOS's generated `.conf` keys → tokens. */
const CONF_KEYS: Record<string, ThemeToken> = {
  BG: 'bg', SURFACE: 'bgAlt', LINE: 'line', FG: 'fg', DIM: 'dim',
  ACCENT: 'chrome', ACCENT2: 'accent2',
  RED: 'err', GREEN: 'ok', YELLOW: 'warn', BLUE: 'info', CYAN: 'cyan',
};

/** adOS's `themes/<name>/palette` keys → tokens. */
const PALETTE_KEYS: Record<string, ThemeToken> = {
  bg: 'bg', bg_alt: 'bgAlt', surface: 'bgAlt', border: 'line', line: 'line',
  fg: 'fg', fg_bright: 'fgBright', dim: 'dim', faint: 'faint', muted: 'soft',
  accent: 'chrome', accent_bright: 'accent2', orange: 'accent2',
  red: 'err', green: 'ok', yellow: 'warn', blue: 'info', cyan: 'cyan',
};

function stripQuotes(v: string): string {
  return v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

interface ParsedThemeFile {
  name?: string;
  font?: string;
  radius?: string;
  tokens: PartialTokens;
}

/**
 * Read one flat `key=value` theme file. Both adOS shapes are accepted: the
 * uppercase generated `.conf` (with `NAME=`/`FONT=`/`RADIUS=`) and the lowercase
 * `palette` next to the OS source. Full-line `#` comments are ignored; the `#`
 * inside a value is colour, not a comment.
 */
export function parseThemeFile(text: string): ParsedThemeFile {
  const out: ParsedThemeFile = { tokens: {} };
  let sawUpper = false;
  let sawLower = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1));
    if (!value) continue;

    if (key === 'NAME') { out.name = value; continue; }
    if (key === 'FONT') { out.font = value; continue; }
    if (key === 'RADIUS') { out.radius = value; continue; }

    const conf = CONF_KEYS[key];
    if (conf) { out.tokens[conf] = value; sawUpper = true; continue; }
    const pal = PALETTE_KEYS[key.toLowerCase()];
    if (pal) {
      // A generated .conf wins over the palette it was generated from; within
      // one file the first spelling of a token wins, so `accent` beats `orange`.
      if (!(sawLower && pal in out.tokens)) out.tokens[pal] = value;
      else if (!(pal in out.tokens)) out.tokens[pal] = value;
      sawLower = true;
    }
  }
  if (!sawUpper && !sawLower) return { tokens: {} };
  return out;
}

function titleCase(id: string): string {
  return id.split(/[-_ ]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

function themeIdFromName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Directories searched for theme files, most specific first. */
export function themeDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    process.env.AURA_THEME_DIR,
    path.join(home, '.aura', 'themes'),
    path.join(home, '.config', 'aura', 'themes'),
    path.join(process.env.AURA_OS_DIR ?? path.join(home, 'aura-os'), 'themes'),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    try {
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch { /* not installed — fine */ }
  }
  return out;
}

function readDirSafe(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Every theme on this machine: the built-ins, plus any theme file adOS (or the
 * user) has dropped in a searched directory. A file with the same id as a
 * built-in replaces it — the user's copy is the authority.
 */
export function discoverThemes(): Theme[] {
  const byId = new Map<string, Theme>();
  for (const t of BUILTINS) byId.set(t.id, t);

  const seenFiles = new Set<string>();
  const add = (file: string, id: string): void => {
    if (!id) return;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const parsed = parseThemeFile(text);
    const theme = makeTheme(id, parsed.name ?? titleCase(id), parsed.tokens, {
      source: file, font: parsed.font, radius: parsed.radius,
    });
    // Every theme file beats a built-in; among files, the first one seen
    // wins — themeDirs() is most specific first, so the generated ~/.config
    // .conf outranks the OS source palette it was generated from.
    if (!theme || seenFiles.has(id)) return;
    seenFiles.add(id);
    byId.set(id, theme);
  };

  for (const dir of themeDirs()) {
    for (const entry of readDirSafe(dir)) {
      const full = path.join(dir, entry);
      // Layout 1 — `themes/<name>.conf`, the generated form.
      if (entry.endsWith('.conf')) {
        add(full, themeIdFromName(entry.slice(0, -'.conf'.length)));
        continue;
      }
      // Layout 2 — adOS source form: `themes/<name>/palette`.
      try {
        if (fs.statSync(full).isDirectory()) {
          add(path.join(full, 'palette'), themeIdFromName(entry));
          continue;
        }
      } catch { /* vanished between listing and stat */ }
      // Layout 3 — a search dir pointed straight at one theme folder.
      if (entry === 'palette') add(full, themeIdFromName(path.basename(dir)));
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Active theme ───────────────────────────────────────────────────────────

export const DEFAULT_THEME_ID = 'nature';

let cache: Theme[] | null = null;
let current: Theme | null = null;
const listeners: Array<(theme: Theme) => void> = [];

export function allThemes(): Theme[] {
  if (!cache) cache = discoverThemes();
  return cache;
}

/** Drop the on-disk cache — used after `:theme reload` and by the tests. */
export function reloadThemes(): Theme[] {
  cache = null;
  return allThemes();
}

function builtinOrDiscovered(id: string): Theme | undefined {
  const wanted = themeIdFromName(id);
  return allThemes().find(t => t.id === wanted);
}

/** The theme named by `$AURA_THEME`, then by `~/.aura/theme`. */
export function configuredThemeId(): string | undefined {
  const env = process.env.AURA_THEME?.trim();
  if (env) return env;
  try {
    const raw = fs.readFileSync(auraThemeFile(), 'utf8').trim();
    if (raw) return raw.split(/\r?\n/)[0]!.trim();
  } catch { /* no choice made yet */ }
  return undefined;
}

/** The theme adOS itself is wearing (`~/.config/aura/theme`), if any. */
export function adOSThemeId(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.config', 'aura', 'theme'), 'utf8').trim();
    return raw ? raw.split(/\r?\n/)[0]!.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where `:theme` records the choice. `$AURA_THEME_FILE` overrides it so tests
 * never write the real `~/.aura/theme`.
 */
export function auraThemeFile(): string {
  return process.env.AURA_THEME_FILE?.trim()
    || path.join(os.homedir(), '.aura', 'theme');
}

/** The live theme. Resolution order: $AURA_THEME → ~/.aura/theme → default. */
export function currentTheme(): Theme {
  if (current) return current;
  const wanted = configuredThemeId();
  const found = (wanted ? builtinOrDiscovered(wanted) : undefined)
    ?? allThemes().find(t => t.id === DEFAULT_THEME_ID)
    ?? allThemes()[0]!;
  current = found;
  return current;
}

export function themeById(id: string): Theme | undefined {
  return builtinOrDiscovered(id);
}

/**
 * Switch themes. An unknown id is a no-op that reports false, so a typo in
 * `:theme` can never leave the UI painting with half a palette.
 */
export function setTheme(id: string): Theme | null {
  const next = builtinOrDiscovered(id);
  if (!next) return null;
  current = next;
  for (const fn of listeners) {
    try { fn(next); } catch { /* a bad listener must not break the switch */ }
  }
  return next;
}

/** Called after a theme switch — the TUI uses it to repaint and re-set OSC 11. */
export function onThemeChange(fn: (theme: Theme) => void): void {
  listeners.push(fn);
}

/** Persist a choice to `~/.aura/theme`, the way adOS records its own. */
export function saveThemeChoice(id: string): void {
  const file = auraThemeFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id + '\n', 'utf8');
  } catch { /* read-only home — the in-memory switch still stands */ }
}

/** Test seam: forget the live theme so the next `currentTheme()` re-resolves. */
export function resetThemeState(): void {
  cache = null;
  current = null;
  listeners.length = 0;
}

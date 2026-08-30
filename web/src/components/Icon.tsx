/**
 * The icon set.
 *
 * Drawn, not typed. The client used Unicode glyphs — ✕ ☰ ⚙ ⠿ ⤷ ← → ✓ ◫ 📷 📄 —
 * and they never form a set: each comes from a different typeface with its own
 * weight, optical size and baseline, so a row of them reads as a row of
 * accidents. Two were colour emoji, which no theme can restyle.
 *
 * One geometry throughout: a 24-unit box, 1.75 stroke, round caps and joins, no
 * fills. That consistency is most of what separates a considered interface from
 * an assembled one, and it costs nothing per icon after the first.
 *
 * Sized in `em` so an icon matches whatever text it sits beside without being
 * told, and `currentColor` so it inherits state — hover, disabled, error — with
 * no per-icon rule anywhere.
 */

export type IconName =
  | 'close' | 'menu' | 'settings' | 'plus' | 'paperclip' | 'send'
  | 'arrow-left' | 'arrow-right' | 'play' | 'trash' | 'link' | 'grip'
  | 'image' | 'file' | 'check' | 'alert' | 'blocked' | 'diamond' | 'search'
  | 'terminal' | 'code' | 'branch' | 'edit' | 'list' | 'flask' | 'zap'
  | 'eye' | 'diff' | 'refresh';

/** Path geometry, in a 24×24 box. */
const PATHS: Record<IconName, string> = {
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M3.5 7h17M3.5 12h17M3.5 17h17',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z'
    + 'M12 19.6a7.6 7.6 0 1 0 0-15.2 7.6 7.6 0 0 0 0 15.2z'
    + 'M19.6 12L22.4 12M17.4 17.4L19.4 19.4M12 19.6L12 22.4M6.6 17.4L4.6 19.4'
    + 'M4.4 12L1.6 12M6.6 6.6L4.6 4.6M12 4.4L12 1.6M17.4 6.6L19.4 4.6',
  plus: 'M12 5v14M5 12h14',
  paperclip: 'M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9',
  send: 'M21 3L10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3z',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  play: 'M7 4.8v14.4L19.5 12 7 4.8z',
  trash: 'M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7',
  link: 'M9.5 14.5l5-5M11 6.5l1.8-1.8a4.2 4.2 0 0 1 6 6L17 12.5M13 17.5l-1.8 1.8a4.2 4.2 0 0 1-6-6L7 11.5',
  grip: 'M9.5 6.5v.01M9.5 12v.01M9.5 17.5v.01M14.5 6.5v.01M14.5 12v.01M14.5 17.5v.01',
  image: 'M3.5 5.5h17v13h-17zM3.5 15.5l4.5-4.5 4 4 3-3 5.5 5.5M9 9.8v.01',
  file: 'M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5zM13.5 3.5V8.5h5',
  check: 'M4.5 12.5l5 5 10-11',
  alert: 'M12 3.5L22 20H2L12 3.5zM12 10v4.5M12 17.5v.01',
  blocked: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  diamond: 'M12 2.8L21.2 12 12 21.2 2.8 12 12 2.8z',
  search: 'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16.5 16.5L21 21',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9a9 9 0 0 1 9 9',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  diff: 'M12 3v18M3 12h18',
  refresh: 'M23 4v6h-6M1 20v-6h6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15',
};

/** Icons that read as a shape rather than an outline. */
const FILLED: ReadonlySet<IconName> = new Set(['play', 'diamond']);

export function Icon({ name, size = '1em', className, title }: {
  name: IconName;
  /** Any CSS length. Defaults to the surrounding text size. */
  size?: string | number;
  className?: string;
  /** Supply only when the icon is the sole label; otherwise it stays hidden. */
  title?: string;
}) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

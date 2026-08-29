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
  | 'image' | 'file' | 'check' | 'alert' | 'blocked' | 'diamond' | 'search';

/** Path geometry, in a 24×24 box. */
const PATHS: Record<IconName, string> = {
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M3.5 7h17M3.5 12h17M3.5 17h17',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z'
    + 'M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-2.72 1.13V21a2 2 0 1 1-4 0v-.1'
    + 'A1.6 1.6 0 0 0 7.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 3 15.1H3a2 2 0 1 1 0-4h.1'
    + 'A1.6 1.6 0 0 0 4.6 7.1a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 8.9 3H9a2 2 0 1 1 4 0v.1'
    + 'a1.6 1.6 0 0 0 2.72 1.13l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 21 8.9V9a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1z',
  plus: 'M12 5v14M5 12h14',
  paperclip: 'M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9',
  send: 'M21 3L10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3z',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  play: 'M7 4.8v14.4L19.5 12 7 4.8z',
  trash: 'M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7',
  link: 'M9.5 14.5l5-5M11 6.5l1.8-1.8a4.2 4.2 0 0 1 6 6L17 12.5M13 17.5l-1.8 1.8a4.2 4.2 0 0 1-6-6L7 11.5',
  // Six dots, drawn as very short strokes so they inherit the same cap and
  // weight as every other icon instead of being punctuation.
  grip: 'M9.5 6.5v.01M9.5 12v.01M9.5 17.5v.01M14.5 6.5v.01M14.5 12v.01M14.5 17.5v.01',
  image: 'M3.5 5.5h17v13h-17zM3.5 15.5l4.5-4.5 4 4 3-3 5.5 5.5M9 9.8v.01',
  file: 'M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5zM13.5 3.5V8.5h5',
  check: 'M4.5 12.5l5 5 10-11',
  alert: 'M12 3.5L22 20H2L12 3.5zM12 10v4.5M12 17.5v.01',
  blocked: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  diamond: 'M12 2.8L21.2 12 12 21.2 2.8 12 12 2.8z',
  search: 'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16.5 16.5L21 21',
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

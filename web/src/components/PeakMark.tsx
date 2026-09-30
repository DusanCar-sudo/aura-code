/**
 * The Aura peak — AuraLogo.kt's path: a cream stroke, with the base arc in
 * gold. Same drawing as the launcher icon and the terminal splash.
 */
export function PeakMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M18 78 C27 54 38 29 48 14 C52 8 58 8 62 14 C73 31 84 55 93 78"
        stroke="var(--peak-body, #f2ebc9)"
        strokeWidth="6"
      />
      <path
        d="M93 78 C77 68 59 63 41 66 C30 68 23 72 18 78"
        stroke="var(--peak-core, #e7cf85)"
        strokeWidth="5"
      />
    </svg>
  );
}

/** Four slanted stripes — the brand's constant. */
export function Stripes({ width = 52, className }: { width?: number; className?: string }) {
  const c = ['#e4312b', '#f8b91e', '#2fae4e', '#1aa6e0'];
  return (
    <svg className={className} width={width} height={width * 0.22} viewBox="0 0 52 11" aria-hidden="true" focusable="false">
      {c.map((fill, i) => (
        <polygon key={fill} fill={fill} points={`${i * 12 + 3},0 ${i * 12 + 16},0 ${i * 12 + 13},11 ${i * 12},11`} />
      ))}
    </svg>
  );
}

/**
 * The Aura sigil: a downward blade with the A at its base and a wing to each
 * side.
 *
 * Two uses, one drawing:
 *   <Sigil watermark />  — the background mark, 10% opacity, behind everything
 *   <Sigil size={20} />  — the inline mark in the header
 *
 * Drawn rather than imported so it inherits currentColor and scales without an
 * asset round-trip — the desktop shell should not need to ship a PNG.
 */
export function Sigil({
  size = 24,
  watermark = false,
  className,
}: {
  size?: number;
  watermark?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={watermark ? undefined : size}
      height={watermark ? undefined : size}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* ── Wings ── swept back from the blade, five primaries a side. */}
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none">
        {/* left */}
        <path d="M92 74 C70 66, 44 68, 26 82 C44 84, 58 88, 70 96" />
        <path d="M92 86 C68 80, 42 84, 24 98 C44 99, 60 103, 72 110" />
        <path d="M92 98 C70 94, 48 100, 32 114 C50 114, 64 117, 74 122" />
        <path d="M92 110 C74 108, 56 114, 42 126 C58 126, 70 128, 78 132" />
        <path d="M92 122 C78 122, 64 127, 54 137 C68 136, 78 138, 84 141" />
        {/* right */}
        <path d="M108 74 C130 66, 156 68, 174 82 C156 84, 142 88, 130 96" />
        <path d="M108 86 C132 80, 158 84, 176 98 C156 99, 140 103, 128 110" />
        <path d="M108 98 C130 94, 152 100, 168 114 C150 114, 136 117, 126 122" />
        <path d="M108 110 C126 108, 144 114, 158 126 C142 126, 130 128, 122 132" />
        <path d="M108 122 C122 122, 136 127, 146 137 C132 136, 122 138, 116 141" />
      </g>

      {/* ── Blade ── point down, so the sigil reads as a sword at rest. */}
      <path
        d="M100 16 L107 42 L107 120 L100 138 L93 120 L93 42 Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
      {/* fuller — the groove down the blade */}
      <path d="M100 34 L100 118" stroke="var(--bg)" strokeWidth="2" strokeOpacity="0.55" />

      {/* ── Crossguard ── */}
      <path
        d="M64 122 L136 122 L131 131 L69 131 Z"
        fill="currentColor"
        fillOpacity="0.9"
      />

      {/* ── Grip ── */}
      <rect x="95" y="131" width="10" height="26" fill="currentColor" fillOpacity="0.75" />

      {/* ── The A, at the base ── pommel and letter in one. */}
      <path
        d="M100 157 L114 190 L106 190 L103.2 182 L96.8 182 L94 190 L86 190 Z"
        fill="currentColor"
      />
      {/* crossbar of the A */}
      <path d="M97.6 176.5 L102.4 176.5" stroke="var(--bg)" strokeWidth="2.4" />
    </svg>
  );
}

/**
 * The watermark layer. Fixed, centred, non-interactive, 10% opacity — present
 * in the way a maker's mark is present, never competing with the conversation.
 */
export function SigilWatermark() {
  return (
    <div className="sigil-watermark" aria-hidden="true">
      <Sigil watermark />
    </div>
  );
}

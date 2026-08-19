/**
 * The :designx style lexicon — the "predetermined designs" the router picks
 * from before any scraping happens.
 *
 * Why a hand-written catalog instead of asking the model to invent a direction
 * from scratch: an LLM asked for "a design" converges on the same centred-hero,
 * indigo-gradient, rounded-card page every single time. Naming a lineage up
 * front ("this is Swiss International, not Y2K chrome") moves the whole
 * generation into a different part of the space, and — more usefully — gives
 * the scrape phase a concrete thing to go looking for. The router hands the
 * agent 2-3 of these, not one, so the build has a tension to resolve rather
 * than a template to fill.
 *
 * `risk` is the dial the user turns with --classic / --wild: 1 is a direction a
 * client signs off on without a meeting, 5 is one that gets you either fired or
 * an award. Nothing here is "safe by default" — even the low-risk entries are
 * opinionated, because the failure mode being designed against is blandness.
 */

export type DesignTarget = 'web' | 'deck' | 'pdf';

export interface DesignStyle {
  id: string;
  /** Display name — printed in the terminal and quoted into the prompt. */
  name: string;
  /** Where it comes from. Gives the model a real reference point, not a vibe. */
  lineage: string;
  /** Colour direction. Deliberately prescriptive: "pick a palette" produces mud. */
  palette: string;
  /** Typography direction, including the pairing logic. */
  type: string;
  /** Layout / composition rule the whole piece obeys. */
  layout: string;
  /** What moves, and what conspicuously does not. */
  motion: string;
  /** 1 = boardroom-safe, 5 = deranged. Filtered by the --classic/--wild dial. */
  risk: 1 | 2 | 3 | 4 | 5;
  /** Which output formats this direction survives. A CSS-grid brutalist wall
   *  does not survive being printed on A4; a print-first direction does. */
  fits: DesignTarget[];
  /** Keywords that pull this style up the ranking for a given brief. */
  cues: string[];
}

export const DESIGN_STYLES: DesignStyle[] = [
  {
    id: 'swiss-brutal',
    name: 'Swiss International, overdriven',
    lineage: 'Müller-Brockmann grid discipline pushed past the point of politeness',
    palette: 'Paper white, ink black, exactly one screaming accent (red 0xE5251F or nothing)',
    type: 'One grotesque (Helvetica Now / Inter Tight) at two extreme sizes — 14px and 140px, nothing between',
    layout: 'Visible 12-column grid, hard left rag, elements aligned to the baseline grid with no exceptions',
    motion: 'Almost none. Type sets instantly; only the accent rule draws itself',
    risk: 2,
    fits: ['web', 'deck', 'pdf'],
    cues: ['report', 'annual', 'data', 'editorial', 'manifesto', 'research', 'whitepaper'],
  },
  {
    id: 'terminal-gothic',
    name: 'Terminal Gothic',
    lineage: 'DEC VT220 phosphor meets blackletter severity',
    palette: 'Near-black #0a0a0c, phosphor green or amber, one bone-white for body',
    type: 'Monospace everywhere (Berkeley Mono / JetBrains Mono), tracking opened on headings',
    layout: 'Fixed character grid — everything snaps to ch units, box-drawing characters as rules',
    motion: 'Typewriter reveals, scanline shimmer, a cursor that never stops blinking',
    risk: 3,
    fits: ['web', 'deck'],
    cues: ['dev', 'cli', 'engineering', 'security', 'infra', 'protocol', 'hacker', 'ai'],
  },
  {
    id: 'risograph',
    name: 'Risograph Misprint',
    lineage: 'Duplicator-press zines — two spot inks, deliberate misregistration',
    palette: 'Two inks only (fluorescent pink + federal blue), overprint multiply where they cross',
    type: 'Condensed sans headline, warm serif body, everything slightly off-baseline',
    layout: 'Collage over grid — torn edges, rotated blocks between -3° and 3°, generous paper margin',
    motion: 'Nothing smooth. Elements snap into place a few pixels off, then settle',
    risk: 4,
    fits: ['web', 'deck', 'pdf'],
    cues: ['zine', 'culture', 'music', 'art', 'community', 'event', 'festival', 'launch'],
  },
  {
    id: 'bauhaus-machine',
    name: 'Bauhaus Machine Shop',
    lineage: 'Dessau primaries and pure geometry, drawn as if by a plotter',
    palette: 'Primary red / yellow / blue on bone, black hairlines',
    type: 'Geometric sans (Futura-alike) with tight tracking; numerals oversized as ornament',
    layout: 'Circles, half-circles and bars composed on a diagonal axis; text runs vertically where it must',
    motion: 'Shapes rotate into position on a single shared arc — one easing curve for the whole piece',
    risk: 3,
    fits: ['web', 'deck', 'pdf'],
    cues: ['product', 'studio', 'agency', 'brand', 'portfolio', 'architecture'],
  },
  {
    id: 'editorial-broadsheet',
    name: 'Broadsheet',
    lineage: 'Front page of a serious newspaper, set for a screen that scrolls',
    palette: 'Newsprint cream, ink, one muted spot for pull-quotes',
    type: 'High-contrast serif display (Tiempos / Playfair) over a workhorse text serif; small caps for labels',
    layout: 'Multi-column measure, drop caps, rules between sections, a real masthead',
    motion: 'Text does not animate. Only images crossfade, slowly',
    risk: 1,
    fits: ['web', 'pdf', 'deck'],
    cues: ['essay', 'story', 'journalism', 'long-form', 'analysis', 'newsletter', 'policy'],
  },
  {
    id: 'y2k-chrome',
    name: 'Y2K Chrome',
    lineage: 'Late-90s software boxes, liquid metal, lens flare without apology',
    palette: 'Chrome gradients, cyan-to-magenta, deep space blue behind',
    type: 'Wide techno sans, heavy outer glow, italic for anything urgent',
    layout: 'Centred symmetry, bevelled panels, starfield or grid horizon in the background',
    motion: 'Everything shines. Specular sweeps across metal, slow parallax starfield',
    risk: 5,
    fits: ['web', 'deck'],
    cues: ['token', 'crypto', 'game', 'launch', 'hype', 'rave', 'nostalgia', 'retro'],
  },
  {
    id: 'ledger-scientific',
    name: 'Scientific Ledger',
    lineage: 'Lab notebooks, LaTeX, engineering drawings — precision as an aesthetic',
    palette: 'Graph-paper blue-grey lines on white, ink navy, one alarm orange for anomalies',
    type: 'Computer Modern-ish serif for prose, tabular monospace for every number',
    layout: 'Fine graph rule behind everything, figure captions numbered, marginalia in the outer column',
    motion: 'Charts draw along their axes; nothing else moves',
    risk: 2,
    fits: ['pdf', 'web', 'deck'],
    cues: ['science', 'benchmark', 'metrics', 'medical', 'finance', 'audit', 'technical'],
  },
  {
    id: 'kinetic-manifesto',
    name: 'Kinetic Manifesto',
    lineage: 'Protest posters and title sequences — type as the only image',
    palette: 'Two colours, maximum contrast, inverted between sections',
    type: 'One enormous variable font, weight and width animated as the reader scrolls',
    layout: 'Full-bleed type walls; each viewport holds exactly one statement',
    motion: 'Scroll drives everything — weight axes, colour inversion, letters that stagger in',
    risk: 4,
    fits: ['web', 'deck'],
    cues: ['manifesto', 'campaign', 'mission', 'statement', 'vision', 'keynote'],
  },
  {
    id: 'soft-scandi',
    name: 'Soft Scandinavian',
    lineage: 'Nordic product design — quiet, warm, obsessively spaced',
    palette: 'Oat, clay, sage, one deep forest; nothing saturated',
    type: 'Humanist sans, generous leading (1.7), long measure, lowercase headings',
    layout: 'Huge white space, asymmetric two-column, soft 20px radii, no hard borders anywhere',
    motion: 'Slow 400ms fades on a gentle ease; hover states lift by 2px and no more',
    risk: 1,
    fits: ['web', 'pdf', 'deck'],
    cues: ['wellness', 'health', 'saas', 'onboarding', 'calm', 'consumer', 'app'],
  },
  {
    id: 'archive-xerox',
    name: 'Archive Xerox',
    lineage: 'Third-generation photocopies, evidence folders, redaction',
    palette: 'Toner black on grey-white, blown-out highlights, one redaction bar black',
    type: 'Typewriter mono for body, rubber-stamp condensed for headings, deliberate ink noise',
    layout: 'Documents on a desk — stacked, slightly rotated, with staples and paperclips as UI',
    motion: 'Page-turn and paper-shuffle only; hovering lifts a sheet off the stack',
    risk: 4,
    fits: ['web', 'pdf', 'deck'],
    cues: ['investigation', 'history', 'archive', 'true-crime', 'leak', 'documentary'],
  },
  {
    id: 'neo-memphis',
    name: 'Neo-Memphis',
    lineage: 'Sottsass and the Memphis Group — squiggles, terrazzo, joyful noise',
    palette: 'Five clashing pastels plus black outlines; no gradients, ever',
    type: 'Chunky geometric display, wide tracking, letters in alternating colours',
    layout: 'Confetti composition — shapes float behind content, nothing perfectly aligned',
    motion: 'Squiggles drift on independent loops; hover makes things wobble',
    risk: 5,
    fits: ['web', 'deck'],
    cues: ['playful', 'kids', 'creative', 'fun', 'party', 'toy', 'education'],
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    lineage: 'Cyanotype architectural drawings, dimension lines, title blocks',
    palette: 'Prussian blue field, white line work, one drafting red for callouts',
    type: 'Technical sans in all caps for labels, small and letter-spaced; numbers tabular',
    layout: 'Title block bottom-right, dimension lines with arrowheads annotating real elements, revision table',
    motion: 'Lines draw themselves along their length; annotations arrive after the drawing',
    risk: 3,
    fits: ['web', 'deck', 'pdf'],
    cues: ['architecture', 'system', 'design-doc', 'plan', 'roadmap', 'spec', 'hardware'],
  },
  {
    id: 'gallery-white',
    name: 'Gallery Wall',
    lineage: 'Museum wall text and exhibition catalogues — the work, then silence',
    palette: 'Gallery white, one warm grey, black text; colour comes only from content',
    type: 'Small, precise sans labels beside enormous quiet serif titles',
    layout: 'Content hung at a consistent eye-line; captions in a fixed narrow column at left',
    motion: 'Only what a visitor causes — an image scales on click, everything else holds still',
    risk: 2,
    fits: ['web', 'deck', 'pdf'],
    cues: ['portfolio', 'gallery', 'photography', 'case-study', 'showcase', 'exhibition'],
  },
  {
    id: 'cassette-futurism',
    name: 'Cassette Futurism',
    lineage: 'The future as imagined in 1979 — CRT amber, beige plastic, chunky switches',
    palette: 'Beige/oatmeal chassis, amber CRT glow, warning red, tape-label orange',
    type: 'Chunky rounded mono, LED seven-segment for figures, worn label-maker tape for section names',
    layout: 'Everything is an instrument panel — bezels, inset screens, physical toggles as controls',
    motion: 'CRT warm-up flicker, needle gauges that overshoot then settle, tape-reel spin',
    risk: 5,
    fits: ['web', 'deck'],
    cues: ['space', 'sci-fi', 'ops', 'dashboard', 'control', 'mission', 'robotics', 'analog'],
  },
];

/** Look up a style by id — returns undefined for an unknown id (the caller
 *  reports it rather than silently substituting something else). */
export function findStyle(id: string): DesignStyle | undefined {
  const needle = id.trim().toLowerCase();
  return DESIGN_STYLES.find(s => s.id === needle || s.name.toLowerCase() === needle);
}

/** Risk bands the --classic / --wild dial maps onto. */
export type DesignDaring = 'classic' | 'balanced' | 'wild' | 'feral';

const DARING_BANDS: Record<DesignDaring, [number, number]> = {
  classic: [1, 2],
  balanced: [1, 4],
  wild: [3, 5],
  feral: [4, 5],
};

/** Tiny deterministic PRNG (mulberry32) so a seed makes the roulette
 *  reproducible — a user who likes what they got can ask for it again. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface RouteOptions {
  brief: string;
  target: DesignTarget;
  daring: DesignDaring;
  /** Forced picks by id — these always survive, in the order given. */
  pinned?: string[];
  /** Reproducibility seed; defaults to a hash of the brief. */
  seed?: number;
  /** How many directions to hand the agent. Two is the useful minimum: one
   *  direction is a template, two is a decision. */
  count?: number;
}

/**
 * Pick the directions for a brief.
 *
 * Scoring is cue-overlap first (a benchmark report should not come back as
 * Neo-Memphis), then a jittered tiebreak so the same brief run twice does not
 * produce a carbon copy — the jitter is bounded below the cue weight, so
 * relevance always beats novelty. Styles that do not survive the target format
 * are dropped outright rather than down-weighted.
 */
export function routeStyles(opts: RouteOptions): DesignStyle[] {
  const { brief, target, daring } = opts;
  const count = Math.max(1, opts.count ?? 2);
  const [lo, hi] = DARING_BANDS[daring];
  const rand = rng(opts.seed ?? seedFrom(brief));
  const words = new Set(brief.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  const picked: DesignStyle[] = [];
  for (const id of opts.pinned ?? []) {
    const s = findStyle(id);
    if (s && !picked.some(p => p.id === s.id)) picked.push(s);
  }

  const pool = DESIGN_STYLES
    .filter(s => s.fits.includes(target))
    .filter(s => s.risk >= lo && s.risk <= hi)
    .filter(s => !picked.some(p => p.id === s.id));

  const scored = pool.map(s => {
    const hits = s.cues.filter(cue => words.has(cue)).length;
    return { style: s, score: hits * 10 + rand() * 9 };
  });
  scored.sort((a, b) => b.score - a.score);

  for (const { style } of scored) {
    if (picked.length >= count) break;
    picked.push(style);
  }
  return picked.slice(0, Math.max(count, opts.pinned?.length ?? 0));
}

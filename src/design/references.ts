/**
 * Where :designx goes looking before it builds anything.
 *
 * The routing idea: a style direction chosen from styles.ts is a hypothesis,
 * and the scrape is how it gets grounded in things that actually exist. Left to
 * itself an agent handed "go find design inspiration" runs one generic search,
 * lands on a listicle, and comes back with adjectives. So the plan is built
 * here instead: named galleries that curate the specific thing we picked, plus
 * queries phrased as the *artefact* we want to see (a type pairing, a grid, a
 * colour system) rather than as a mood.
 *
 * Nothing here is fetched by this module — it emits a plan the agent executes
 * with its own web_search / web_fetch tools, so the scrape runs under the same
 * SSRF and permission rules as any other fetch. The agent is told explicitly
 * that these are starting points and it may leave them; a plan that forbids
 * wandering just relocates the blandness.
 */

import type { DesignStyle, DesignTarget } from './styles.js';

export interface ReferenceSource {
  url: string;
  name: string;
  /** What this source is actually good for — kept in the prompt so the agent
   *  fetches with a question rather than fetching to have fetched. */
  why: string;
  targets: DesignTarget[];
}

export const REFERENCE_SOURCES: ReferenceSource[] = [
  {
    url: 'https://www.awwwards.com/websites/',
    name: 'Awwwards',
    why: 'Award-winning sites — read the jury notes for what is technically ambitious right now',
    targets: ['web'],
  },
  {
    url: 'https://godly.website/',
    name: 'Godly',
    why: 'Tightly curated modern web design; good for current layout and motion conventions',
    targets: ['web'],
  },
  {
    url: 'https://www.siteinspire.com/',
    name: 'SiteInspire',
    why: 'Filterable by style and type — the closest thing to querying a style directly',
    targets: ['web'],
  },
  {
    url: 'https://brutalistwebsites.com/',
    name: 'Brutalist Websites',
    why: 'Raw, rule-breaking layouts — the antidote when a build starts drifting to template centre',
    targets: ['web'],
  },
  {
    url: 'https://www.typewolf.com/',
    name: 'Typewolf',
    why: 'Real type pairings with the actual families named — take the pairing, not the vibe',
    targets: ['web', 'deck', 'pdf'],
  },
  {
    url: 'https://fontsinuse.com/',
    name: 'Fonts In Use',
    why: 'Typography in print and identity work, annotated with the fonts and the context',
    targets: ['pdf', 'deck', 'web'],
  },
  {
    url: 'https://www.thisiscolossal.com/category/design/',
    name: 'Colossal — Design',
    why: 'Art-side references that pull a piece away from software-default aesthetics',
    targets: ['web', 'deck', 'pdf'],
  },
  {
    url: 'https://presentationzen.blogs.com/',
    name: 'Presentation Zen',
    why: 'Slide structure and narrative pacing — how a deck argues, not how it decorates',
    targets: ['deck'],
  },
  {
    url: 'https://www.behance.net/search/projects?search=editorial%20design',
    name: 'Behance — Editorial',
    why: 'Print and editorial spreads: grids, margins, and how long documents hold rhythm',
    targets: ['pdf', 'deck'],
  },
  {
    url: 'https://www.smashingmagazine.com/category/design/',
    name: 'Smashing Magazine',
    why: 'Implementation-level write-ups — CSS grid, print stylesheets, variable fonts',
    targets: ['web', 'pdf'],
  },
];

export interface ScrapePlan {
  /** Search queries, most specific first. */
  queries: string[];
  /** Curated pages worth fetching outright. */
  seeds: ReferenceSource[];
}

/**
 * Build the research plan for a brief + the routed styles.
 *
 * Queries are style-led rather than brief-led on purpose: searching the brief
 * ("landing page for a token") returns competitors, and copying competitors is
 * how everything converged in the first place. Searching the *direction*
 * ("risograph misregistration two-colour overprint web") returns craft.
 */
export function buildScrapePlan(
  styles: DesignStyle[],
  target: DesignTarget,
  brief: string,
): ScrapePlan {
  const medium = target === 'web' ? 'website' : target === 'deck' ? 'presentation slides' : 'print layout';
  const queries: string[] = [];

  for (const s of styles) {
    queries.push(`${s.name} ${medium} examples ${new Date().getFullYear()}`);
    queries.push(`${s.lineage} typography and grid reference`);
  }
  queries.push(`${brief.slice(0, 80)} ${medium} design case study`);
  if (target === 'pdf') queries.push('CSS paged media print stylesheet @page real-world example');
  if (target === 'deck') queries.push('presentation design principles one idea per slide typography');

  const seeds = REFERENCE_SOURCES.filter(r => r.targets.includes(target)).slice(0, 5);
  return { queries, seeds };
}

/**
 * Argument parsing for `:designx`. Pure and side-effect free so the whole
 * surface can be tested without a provider — the REPL branch in cli/index.ts
 * self-executes on import, so anything that lives there is untestable, and a
 * flag that silently stops working is exactly the kind of bug that hides in a
 * command people run once a week.
 *
 * Shape:
 *   :designx [web|deck|pdf] <brief> [flags]
 *
 * The target may be omitted — briefs say what they are ("a 10-slide deck…",
 * "a one-page PDF…") far more often than users remember a subcommand.
 */

import type { DesignTarget, DesignDaring } from './styles.js';

export interface DesignXArgs {
  brief: string;
  target: DesignTarget;
  /** True when the target came from the brief rather than an explicit token —
   *  reported to the user so a wrong guess is visible and correctable. */
  targetInferred: boolean;
  daring: DesignDaring;
  /** Style ids pinned with --style. */
  pinned: string[];
  /** Number of directions to route. */
  count: number;
  seed?: number;
  /** --no-scrape: skip the reference pass (offline, or the user knows what they want). */
  scrape: boolean;
  /** --out <dir>: output directory relative to the project root. */
  out?: string;
  /** :designx styles — list the lexicon instead of building. */
  listStyles: boolean;
}

const TARGET_WORDS: Record<string, DesignTarget> = {
  web: 'web', site: 'web', page: 'web', landing: 'web', html: 'web',
  deck: 'deck', slides: 'deck', presentation: 'deck', keynote: 'deck', pitch: 'deck',
  pdf: 'pdf', print: 'pdf', poster: 'pdf', report: 'pdf', document: 'pdf',
};

/** Guess the artefact from the brief's own words. Explicit tokens win; this
 *  only runs when the user did not say. Ties go to `web` — it is both the most
 *  common ask and the cheapest to redo. */
export function inferTarget(brief: string): DesignTarget {
  const words = brief.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const tally: Record<DesignTarget, number> = { web: 0, deck: 0, pdf: 0 };
  for (const w of words) {
    const t = TARGET_WORDS[w];
    if (t) tally[t]++;
  }
  if (tally.deck > tally.web && tally.deck >= tally.pdf) return 'deck';
  if (tally.pdf > tally.web && tally.pdf > tally.deck) return 'pdf';
  return 'web';
}

function takeFlagValue(tokens: string[], i: number): string | undefined {
  const next = tokens[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

/**
 * Parse the raw argument string (everything after `:designx`).
 * Unknown `--flags` are left in the brief rather than rejected — the brief is
 * free text and a hard error on an unrecognised dash would make phrases like
 * "--- section dividers" unusable.
 */
export function parseDesignXArgs(raw: string): DesignXArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  const args: DesignXArgs = {
    brief: '',
    target: 'web',
    targetInferred: true,
    daring: 'balanced',
    pinned: [],
    count: 2,
    scrape: true,
    listStyles: false,
  };

  if (tokens[0] === 'styles' || tokens[0] === '--styles') {
    args.listStyles = true;
    return args;
  }

  let start = 0;
  const explicit = tokens[0]?.toLowerCase();
  if (explicit === 'web' || explicit === 'deck' || explicit === 'pdf') {
    args.target = explicit;
    args.targetInferred = false;
    start = 1;
  }

  const briefParts: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case '--classic': args.daring = 'classic'; continue;
      case '--wild': args.daring = 'wild'; continue;
      case '--feral': args.daring = 'feral'; continue;
      case '--no-scrape': args.scrape = false; continue;
      case '--style': {
        const v = takeFlagValue(tokens, i);
        if (v) { args.pinned.push(...v.split(',').map(s => s.trim()).filter(Boolean)); i++; }
        continue;
      }
      case '--seed': {
        const v = takeFlagValue(tokens, i);
        if (v && /^\d+$/.test(v)) { args.seed = Number(v); i++; }
        continue;
      }
      case '--count': {
        const v = takeFlagValue(tokens, i);
        if (v && /^\d+$/.test(v)) { args.count = Math.min(4, Math.max(1, Number(v))); i++; }
        continue;
      }
      case '--out': {
        const v = takeFlagValue(tokens, i);
        if (v) { args.out = v; i++; }
        continue;
      }
      default:
        briefParts.push(t);
    }
  }

  args.brief = briefParts.join(' ').trim();
  if (args.targetInferred && args.brief) args.target = inferTarget(args.brief);
  return args;
}

/** Filesystem-safe slug for the output directory. */
export function slugifyBrief(brief: string): string {
  return brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'design';
}

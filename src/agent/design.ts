import * as fs from 'fs';
import * as path from 'path';

/**
 * Design-system injection for UI/website builds.
 *
 * When a task is about building a website or UI, Aura loads a design "skill"
 * (a SKILL.md from `design-systems/<slug>/`) into the system prompt so the
 * generated markup follows real tokens, components, and accessibility rules
 * instead of generic defaults. Library: bergside/awesome-design-skills (MIT).
 *
 * Selection is keyword-based and cheap (no extra LLM call):
 *   1. If the task names a known slug/name ("make it brutalist", "luxury style",
 *      "terracotta"), that skill is used.
 *   2. Otherwise the project default applies (AURA_DESIGN env or "terracotta").
 *   3. If the task isn't a UI/website build at all, nothing is injected.
 */

const DIRNAME = 'design-systems';

/** Resolved at call time so `:design <slug>` / `:design off` take effect live. */
function defaultSlug(): string {
  return process.env.AURA_DESIGN || 'terracotta';
}

/** Phrases that mark a task as UI/website work. */
const WEB_SIGNALS = [
  'website', 'web site', 'webpage', 'web page', 'landing page', 'homepage',
  'home page', 'ui', 'frontend', 'front-end', 'front end', 'web app', 'webapp',
  'html', 'css', 'tailwind', 'react component', 'design', 'redesign', 'restyle',
  'portfolio', 'dashboard', 'hero section', 'marketing page', 'site for',
];

export interface DesignSelection {
  slug: string;
  name: string;
  skillText: string;
  matchedByName: boolean;
}

/** Common natural-language variants → canonical slug. Keeps "make it brutalist"
 *  or "minimalist look" matching the right skill without fuzzy guessing. */
const ALIASES: Record<string, string> = {
  brutalist: 'brutalism',
  neobrutalist: 'neobrutalism',
  minimalist: 'minimal',
  minimalistic: 'minimal',
  luxurious: 'luxury',
  glassy: 'glassmorphism',
  glass: 'glassmorphism',
  neumorphic: 'neumorphism',
  claymorphic: 'claymorphism',
  skeuomorphic: 'skeumorphism',
  skeuomorphism: 'skeumorphism',
  editorialstyle: 'editorial',
  corporatey: 'corporate',
  retrostyle: 'retro',
  vintagestyle: 'vintage',
  professionallooking: 'professional',
};

function designsRoot(projectRoot: string): string {
  return path.join(projectRoot, DIRNAME);
}

/** All available slugs (folder names) in the library, sorted. */
export function listDesignSlugs(projectRoot: string): string[] {
  try {
    return fs.readdirSync(designsRoot(projectRoot), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Is this task asking to build/modify a website or UI? */
export function isWebBuildTask(task: string): boolean {
  const t = task.toLowerCase();
  return WEB_SIGNALS.some(sig => t.includes(sig));
}

/** Load a skill's SKILL.md text, or null if missing. */
function loadSkill(projectRoot: string, slug: string): string | null {
  try {
    return fs.readFileSync(path.join(designsRoot(projectRoot), slug, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

function titleCase(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * Decide which design skill (if any) applies to this task.
 * Returns null when the task is not a UI/website build or no library exists.
 */
export function selectDesign(projectRoot: string, task: string): DesignSelection | null {
  const slugs = listDesignSlugs(projectRoot);
  if (slugs.length === 0) return null;

  const t = task.toLowerCase();

  // 1a. Alias forms ("brutalist", "minimalist") → canonical slug.
  for (const [alias, slug] of Object.entries(ALIASES)) {
    if (slugs.includes(slug) && new RegExp(`\\b${alias}\\b`).test(t)) {
      const skillText = loadSkill(projectRoot, slug);
      if (skillText) return { slug, name: titleCase(slug), skillText, matchedByName: true };
    }
  }

  // 1b. Explicit style named in the task wins, even if it's not obviously "web"
  //     (e.g. "give the page a brutalist look").
  const named = slugs.find(s => {
    // match the slug or its spaced/title form as a whole word
    const forms = new Set([s, s.replace(/-/g, ' '), titleCase(s).toLowerCase()]);
    return [...forms].some(f => new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
  });
  if (named) {
    const skillText = loadSkill(projectRoot, named);
    if (skillText) return { slug: named, name: titleCase(named), skillText, matchedByName: true };
  }

  // 2. No explicit style — only inject if this looks like a web/UI build.
  if (!isWebBuildTask(task)) return null;

  const def = defaultSlug();
  if (def === '__none__') return null; // auto-injection disabled via :design off

  const fallback = slugs.includes(def) ? def : slugs[0];
  const skillText = loadSkill(projectRoot, fallback);
  if (!skillText) return null;
  return { slug: fallback, name: titleCase(fallback), skillText, matchedByName: false };
}

/** Render the design selection as a system-prompt section. */
export function designPromptSection(sel: DesignSelection): string {
  return (
    `\n\n## Active design system: ${sel.name}\n` +
    `This is a UI/website task. Build the interface to match the design system below — ` +
    `its colour tokens, typography, spacing, component styles, and accessibility rules are ` +
    `authoritative. Do not fall back to generic defaults.` +
    (sel.matchedByName ? '' : ` (Default style "${sel.slug}"; the user can name another, e.g. "make it luxury" or ":design <slug>".)`) +
    `\n\n${sel.skillText}\n`
  );
}

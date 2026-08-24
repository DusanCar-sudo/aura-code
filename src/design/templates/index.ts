/**
 * House stylesheets for printable artefacts.
 *
 * These are *stylesheets*, not string-substitution templates. The agent writes
 * its own markup and includes one of these — which keeps the design routing in
 * design/styles.ts meaningful (a template that dictated layout would fight it)
 * and means a résumé and a report differ in paged-media rules rather than in
 * how the content is generated.
 *
 * Everything here is print-first, because that is where CSS knowledge is
 * thinnest and where the failures are ugly and invisible until someone prints:
 * headings stranded at the foot of a page, a table row split across a page
 * break, a figure separated from its caption, backgrounds silently dropped.
 * Screen rendering is the easy case and the browser already handles it.
 */

export type TemplateName = 'resume' | 'report' | 'paper' | 'deck';

/** Shared by every template. The paged-media rules that are almost always
 *  wanted and almost never written by hand. */
const BASE = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; -webkit-font-smoothing: antialiased; }

  /* Chrome drops backgrounds when printing unless told twice: the standard
     property and the WebKit one. A dark artefact prints as white paper
     without this, which is not a subtle failure. */
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* A heading alone at the bottom of a page, or one orphaned line carried to
     the next, is the most common print defect in generated documents. */
  h1, h2, h3, h4 { break-after: avoid-page; page-break-after: avoid; }
  p, li { orphans: 3; widows: 3; }

  /* A figure split from its caption, or a row split mid-cell, is unreadable
     rather than merely untidy. */
  figure, tr, .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }   /* repeat headers on every page */
  tfoot { display: table-footer-group; }

  /* A long URL cannot be reflowed by justification and will otherwise punch
     out past the page edge. */
  a { word-break: break-word; }

  img, svg, table { max-width: 100%; }

  @media print {
    /* On paper a link's colour conveys nothing; its target does. Applied only
       to external links, since internal cross-references would become noise. */
    a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #555; }
    .no-print { display: none !important; }
  }
`;

const TEMPLATES: Record<TemplateName, { description: string; css: string }> = {
  resume: {
    description: 'One- or two-page résumé. Tight vertical rhythm, no running heads.',
    css: `${BASE}
  @page { size: A4; margin: 14mm 16mm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.45; color: #16181d; }
  h1 { font-size: 24pt; margin: 0 0 2pt; letter-spacing: -0.01em; }
  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.14em;
       margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 0.5pt solid #c9ccd2; }
  h3 { font-size: 11pt; margin: 10pt 0 1pt; }
  ul { margin: 4pt 0; padding-left: 14pt; }
  li { margin: 2pt 0; }
  /* A role and its bullets belong together; a break between them reads as two
     different jobs. */
  .role, .entry { break-inside: avoid; page-break-inside: avoid; }
  .meta { color: #5b6069; font-size: 9pt; }`,
  },

  report: {
    description: 'Business report. Running header, page numbers, figure-friendly.',
    css: `${BASE}
  @page { size: A4; margin: 22mm 20mm 24mm; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #1a1c20; }
  h1 { font-size: 26pt; margin: 0 0 12pt; }
  h2 { font-size: 15pt; margin: 20pt 0 6pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; }
  /* Each top-level section starts a page — the convention readers expect when
     a report has a contents page. */
  section.chapter { break-before: page; }
  section.chapter:first-of-type { break-before: auto; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10pt; }
  th, td { border: 0.5pt solid #ccd0d6; padding: 5pt 7pt; text-align: left; }
  th { background: #f2f4f7; font-weight: 600; }
  figure { margin: 14pt 0; }
  figcaption { font-size: 9pt; color: #5b6069; margin-top: 4pt; }
  blockquote { margin: 12pt 0; padding-left: 12pt; border-left: 2pt solid #ccd0d6; color: #40454d; }`,
  },

  paper: {
    description: 'Academic paper. Two-column body, numbered sections, references.',
    css: `${BASE}
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: 'Times New Roman', Times, serif; font-size: 10pt; line-height: 1.4; color: #000; }
  /* Title and abstract span the full width; only the body is two-column, which
     is what every journal template does and what column-span exists for. */
  .fullwidth, h1, .abstract { column-span: all; }
  main { column-count: 2; column-gap: 8mm; }
  h1 { font-size: 17pt; text-align: center; margin: 0 0 6pt; }
  .authors { text-align: center; font-size: 10pt; margin-bottom: 10pt; }
  .abstract { font-size: 9pt; margin: 0 0 12pt; padding: 8pt 10pt; background: #f6f6f6; }
  h2 { font-size: 11pt; margin: 12pt 0 4pt; }
  h3 { font-size: 10pt; font-style: italic; margin: 8pt 0 3pt; }
  /* A figure wider than a column has to escape it, or it is clipped. */
  figure.wide { column-span: all; }
  figcaption { font-size: 8.5pt; }
  .references { font-size: 9pt; }
  .references li { margin-bottom: 3pt; }
  sup.cite { font-size: 7.5pt; }`,
  },

  deck: {
    description: '16:9 slides, one @page per slide. Renders to a PDF deck.',
    css: `${BASE}
  /* 16:9 at a size Chrome maps cleanly to pixels. Slides carry their own
     padding, so the page margin is zero — a margin here would inset every
     full-bleed background. */
  @page { size: 338mm 190mm; margin: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #12141a; background: #fff; }
  .slide {
    width: 338mm; height: 190mm; padding: 20mm 24mm;
    display: flex; flex-direction: column; justify-content: center;
    break-after: page; page-break-after: always;
    position: relative; overflow: hidden;
  }
  /* Without this the deck ends on a trailing blank page — the break after the
     last slide has nothing to precede. */
  .slide:last-child { break-after: auto; page-break-after: auto; }
  .slide h1 { font-size: 40pt; margin: 0 0 10mm; line-height: 1.1; }
  .slide h2 { font-size: 26pt; margin: 0 0 8mm; }
  .slide li { font-size: 18pt; margin: 4mm 0; }
  .slide .kicker { font-size: 11pt; letter-spacing: 0.16em; text-transform: uppercase; color: #6b7280; }
  /* Speaker notes are authoring aids, never part of the rendered deck. */
  .notes { display: none; }`,
  },
};

/** CSS for a template, ready to drop in a <style> block. */
export function templateCss(name: TemplateName): string {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`unknown template: ${name}`);
  return t.css.trim();
}

export function templateNames(): TemplateName[] {
  return Object.keys(TEMPLATES) as TemplateName[];
}

export function templateDescription(name: TemplateName): string {
  return TEMPLATES[name]?.description ?? '';
}

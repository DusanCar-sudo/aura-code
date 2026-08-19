/**
 * The :designx task prompt.
 *
 * Two things this file is fighting, and both are why it is this long:
 *
 * 1. Regression to the mean. An agent asked to "design a nice landing page"
 *    emits the same page every time — centred hero, indigo gradient, three
 *    feature cards, rounded corners, a footer nobody reads. Every constraint
 *    below exists to make that specific page impossible to produce.
 * 2. Pretty but wrong. A deck that looks incredible and buries its argument has
 *    failed at the actual job. So the brief's *point* is stated first and the
 *    style is subordinate to it — the direction is how the argument is carried,
 *    not what replaces it.
 *
 * Output contracts are per-target and deliberately concrete (filenames, single
 * file, no CDN) because "make it self-contained" gets interpreted generously
 * and then the artefact breaks the moment it is opened offline.
 */

import type { DesignStyle, DesignTarget, DesignDaring } from './styles.js';
import type { ScrapePlan } from './references.js';

function styleBlock(s: DesignStyle, i: number): string {
  return [
    `  Direction ${i + 1} — ${s.name}  [risk ${s.risk}/5]`,
    `    Lineage : ${s.lineage}`,
    `    Palette : ${s.palette}`,
    `    Type    : ${s.type}`,
    `    Layout  : ${s.layout}`,
    `    Motion  : ${s.motion}`,
  ].join('\n');
}

const TARGET_CONTRACTS: Record<DesignTarget, string> = {
  web: [
    'ARTEFACT — a web page.',
    '- Write exactly one file: `index.html`. All CSS and JS inline. No CDN links, no',
    '  external fonts, no remote images — it must render correctly with the network off.',
    '- Typography: system/local font stacks only, but pick them deliberately and state the',
    '  stack in a comment. If the direction needs a face you cannot embed, get as close as',
    '  the stack allows and adjust size/tracking/weight to compensate.',
    '- Responsive down to 380px. Nothing may scroll the page horizontally; wide elements',
    '  scroll inside their own container.',
    '- Both themes: define the full palette as CSS custom properties on `:root`, and',
    '  redefine only those properties under `@media (prefers-color-scheme: dark)`. Give',
    '  `body` an explicit background — never transparent.',
    '- Motion respects `prefers-reduced-motion: reduce`.',
    '- Any imagery is inline SVG or CSS you author. No placeholder image services.',
  ].join('\n'),
  deck: [
    'ARTEFACT — a presentation.',
    '- Write exactly one file: `deck.html`. Self-contained, no CDN, no external assets.',
    '- 16:9 slides that scale to the viewport (a fixed design size scaled with a transform,',
    '  or viewport-relative units throughout — pick one and be consistent).',
    '- Navigation: ← / → and Space to move, Home/End to jump, `F` for fullscreen, and a',
    '  slide counter. Keyboard handlers must not fight browser find-in-page.',
    '- One idea per slide. If a slide has two arguments on it, it is two slides.',
    '- Speaker-safe: nothing below 24px at design size; no body text under 20px.',
    '- `@media print` puts exactly one slide per page, backgrounds preserved',
    '  (`print-color-adjust: exact`), so Cmd-P produces a usable PDF.',
  ].join('\n'),
  pdf: [
    'ARTEFACT — a print document.',
    '- Write exactly one file: `document.html`, authored for paged media and self-contained.',
    '- `@page { size: A4; margin: … }` with named page rules where the design needs them.',
    '- Real print typography: a measure of 60-75 characters, hyphenation on, widows and',
    '  orphans controlled, `break-inside: avoid` on figures and tables.',
    '- Design in millimetres and points, not pixels. Screen preview is a side effect.',
    '- Running headers/footers and page numbers via `@page` margin boxes where supported,',
    '  with a fixed-position fallback that does not break the flow.',
    '- After writing it, try to render `document.pdf` with headless Chrome',
    '  (`chromium`/`google-chrome`/`chrome` — `--headless --print-to-pdf=… --no-pdf-header-footer`).',
    '  If no binary exists, say so plainly in the report and move on; do not install anything.',
  ].join('\n'),
};

const DARING_CLAUSE: Record<DesignDaring, string> = {
  classic: 'Restraint is the assignment. Be excellent inside convention — the craft shows in spacing, rhythm and typographic detail, not in surprise.',
  balanced: 'Anchor the piece in one direction and let the second one break it in exactly two or three places. The tension is the design.',
  wild: 'Push it. Take the direction past where a cautious designer would stop, and make the one weird decision the whole piece is remembered for. It must still be readable and it must still make the argument.',
  feral: 'Go all the way. This should look like nothing else on the internet — invent a mechanic, not a layout. The only floors are: the argument still lands, the text is still readable, and it still works on a phone.',
};

export interface BuildPromptOpts {
  brief: string;
  target: DesignTarget;
  daring: DesignDaring;
  styles: DesignStyle[];
  plan: ScrapePlan | null;
  /** Directory (relative to project root) the files must be written into. */
  outDir: string;
}

export function buildDesignXPrompt(o: BuildPromptOpts): string {
  const parts: string[] = [];

  parts.push(
    `You are designing and building a real artefact. This is a design commission, not a coding ticket.\n`,
    `THE BRIEF\n"${o.brief}"\n`,
    `Before anything else, decide in one sentence what this artefact has to DO — what the reader\n` +
    `should think, feel or do by the end. Write that sentence down; every later decision answers to it.\n`,
  );

  parts.push(
    `\nROUTED DIRECTIONS\n` +
    `These were chosen for this brief from Aura's design lexicon. They are the starting point, not\n` +
    `a menu of decoration. Read them as constraints — a direction you follow only loosely produces\n` +
    `the same generic page as no direction at all.\n\n` +
    o.styles.map(styleBlock).join('\n\n'),
  );

  parts.push(`\nHOW DARING\n${DARING_CLAUSE[o.daring]}`);

  if (o.plan) {
    parts.push(
      `\nRESEARCH PASS — do this first, before writing any markup.\n` +
      `Use web_search and web_fetch to ground the directions in work that actually exists. You are\n` +
      `looking for specifics you can steal at the craft level: exact type pairings, grid ratios,\n` +
      `colour relationships, a motion idea, a layout mechanic. You are not looking for adjectives,\n` +
      `and you are not copying anyone's page.\n\n` +
      `Suggested searches:\n${o.plan.queries.map(q => `  - ${q}`).join('\n')}\n\n` +
      `Curated starting points (fetch the ones that fit; leave them freely if a search finds better):\n` +
      o.plan.seeds.map(s => `  - ${s.name} — ${s.url}\n      ${s.why}`).join('\n') + '\n\n' +
      `Budget roughly 4-6 fetches. Then STOP researching and start building — more references past\n` +
      `that point make the design more average, not less.\n\n` +
      `IF SEARCH IS BROKEN: if two searches in a row return an error or nothing useful, the tool is\n` +
      `down — not the topic obscure. Do NOT retry with broader or simpler wording; a search for\n` +
      `"design" or "computer" tells you nothing you did not already know. Abandon the research pass\n` +
      `immediately, say one line about it in DESIGN.md, and build from the routed directions alone.\n` +
      `They contain enough to design from. An artefact built with no references is a result; a run\n` +
      `that searches twelve times and writes no file is a failure.`,
    );
  } else {
    parts.push(`\nNo research pass this run (--no-scrape). Build from the routed directions alone.`);
  }

  parts.push(`\n${TARGET_CONTRACTS[o.target]}`);

  parts.push(
    `\nOUTPUT LOCATION\n` +
    `Write everything into \`${o.outDir}/\` (create it). Also write \`${o.outDir}/DESIGN.md\`: the one-sentence\n` +
    `job of the artefact, which direction you led with and why, the two or three decisions you would\n` +
    `have to defend in a review, and anything you tried and rejected.`,
  );

  parts.push(
    `\nHOW TO WRITE THE FILE — this is where these runs fail, so read it twice.\n` +
    `- Use the write_file tool, with the ENTIRE finished document as the content, in ONE call.\n` +
    `- Do NOT write a skeleton with placeholders like /* INSERT_CSS_HERE */ or <!-- BODY --> and\n` +
    `  then fill them in afterwards. Every run that has done this has ended with the placeholders\n` +
    `  still in the file: the follow-up step fails or gets cut off, and the artefact ships as an\n` +
    `  empty shell that looks finished from the outside.\n` +
    `- Do NOT author the file through the shell — no 'cat > file <<EOF', no echo-append, no sed\n` +
    `  patching. write_file exists for this and is the only reliable path.\n` +
    `- If the document feels too large to emit in one call: it is not. Emit it. A long single\n` +
    `  write always beats a sequence of patches.\n` +
    `- After the write, your own copy of what you sent is replaced by a size stub — you will NOT be\n` +
    `  able to re-read your draft from the conversation. Read the file back from disk with read_file\n` +
    `  when you need to check it. Plan the whole document before you start writing, not during.\n` +
    `- Before reporting done, read the file back and confirm: it parses, it contains no placeholder\n` +
    `  markers, and the body is real content rather than a stub.`,
  );

  parts.push(
    `\nNON-NEGOTIABLE\n` +
    `- Real content. Use the brief's actual subject matter and write real copy. No lorem ipsum, no\n` +
    `  "Feature One / Feature Two", no invented statistics, no fake testimonials or logos. If you\n` +
    `  genuinely need a fact you do not have, write the line so it does not need one.\n` +
    `- Contrast passes WCAG AA for body text. An eccentric palette is not an excuse for grey-on-grey.\n` +
    `- Ship it finished. No TODOs, no commented-out alternatives, no "you could also…" left in the file.\n` +
    `- Verify before reporting: open the file you wrote and read it back. A page that does not parse\n` +
    `  is not a design.\n`,
  );

  parts.push(
    `\nTHE THING TO AVOID\n` +
    `The default AI artefact: centred hero, gradient headline, three rounded feature cards, a pill\n` +
    `button, generic sans throughout, indigo-to-purple everything. If what you are building starts\n` +
    `converging on that, you have stopped designing. Go back to the direction and take it further.\n`,
  );

  parts.push(
    `\nWhen you are done, report: the file paths you wrote, the direction you led with, and the one\n` +
    `decision you think is most likely to be argued about.`,
  );

  return parts.join('\n');
}

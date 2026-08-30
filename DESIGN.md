---
name: Aura Code — web client
description: The terminal agent's graphical surface, in the TUI's own colours.
colors:
  bg: "#0f1724"
  surface-sunken: "#151d2c"
  panel-bg: "#1c2739"
  panel-raised: "#22304a"
  surface-float: "#293954"
  line: "#243149"
  line-soft: "#1a2436"
  line-strong: "#35476a"
  accent: "#cc785c"
  accent-bright: "#e08e6f"
  accent-dim: "#a05c45"
  ruby: "#9b1b30"
  text: "#e8e6e3"
  text-dim: "#8a94a6"
  faint: "#4a5568"
  ok: "#5a9e6e"
  warn: "#d4903a"
  err: "#b15439"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, Inter, Roboto, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, Inter, Roboto, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, Inter, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, Inter, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "normal"
  code:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Fira Code, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    typography: "{typography.label}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  button-quiet-hover:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text}"
  card:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "12px"
  column:
    backgroundColor: "{colors.line-soft}"
    rounded: "{rounded.sm}"
    padding: "12px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
---

# Aura Code — web client design

## Overview

This governs `web/` only: the browser client served by `aura serve`. The TUI
(`src/cli/`) is a separate surface with its own constraints, and `AURA.md` names
the third — the marketing site in `site/`. A change to one is not a change to
the others.

Mode is **Operate**. Someone is here to get work done: start a task, watch it
run, read what came back. Scanability and predictable behaviour outrank
expression, and the brand lives in precise details rather than in decoration.

The identity is the terminal's, rendered graphically. Colours originate in
`src/cli/diamond.ts` so the two surfaces read as one product. That does not mean
the web client should imitate a terminal: it means it should not invent a second
palette. Depth, motion, and drawn icons are the graphical surface doing its own
job well, not a departure.

**The tokens in `web/src/styles/theme.css` are the source of truth.** The
frontmatter above mirrors them for tools; if the two ever disagree, the
stylesheet is right and this file is stale.

## Colors

Surfaces are a ramp, not a set of unrelated greys: `surface-sunken` holds
content, `panel-bg` is the resting plane, `panel-raised` is a card or a control,
`surface-float` is something lifted off the page. Anything that needs "a
slightly different background" picks the next step instead of inventing a hex.

`accent` (terracotta) carries interaction and identity. It has a family —
`accent-bright` for hover, `accent-dim` for pressed, `accent-wash` and
`accent-edge` for tinted surfaces — because one flat accent everywhere is what
makes an interface look assigned rather than designed.

`ok` / `warn` / `err` are states and never decoration. `ruby` is the brand mark's
own colour; it belongs to the sigil, not to UI chrome.

Both themes are defined. Light redefines the same token names rather than adding
new ones, so nothing in a component is theme-aware.

## Typography

One family for the interface, monospace only for what is genuinely code, data or
a measurement — a path, a model id, a token count. Monospace as a costume for
"technical" is the failure mode to avoid.

Three weights carry hierarchy: 400 for body, 550 for something that leads, 650
for a heading. Size is not the only axis — a heading that has to shout by being
large is a heading that was not given weight. Titles and display sizes take
`-0.02em` tracking; body takes none.

Body measure stays in the 65–75 character range; `--col-w` exists for exactly
that reason in the chat column.

## Layout

`--space-1` through `--space-7` (4 → 48px). Related things sit tight, distinct
groups get real separation, and a heading takes more space above it than below —
it belongs to what follows.

The shell is a fixed sidebar plus a main column. The chat column is centred on
the *viewport*, not in the space beside the sidebar; `padding-inline-end:
var(--sidebar-w)` achieves that and is deliberate.

Board columns shrink to fit so every stage is visible at once, stopping at
`min-width` and scrolling the row instead. A column parked off the right edge
defeats the point of a board.

Arabic is supported, so every directional property is logical
(`inset-inline-start`, `padding-inline-end`) — never `left`/`right`.

## Elevation & Depth

Four steps, `--shadow-1` to `--shadow-4`. Every shadow has **an offset and a
soft blur**, because light comes from above; a zero-offset coloured halo is
decoration, not depth. Each step pairs a tight contact shadow with a wider
ambient one so edges do not look cut out.

Resting cards take `--shadow-1`, hover `--shadow-2`, a dragged tile
`--shadow-4`. Blur (`backdrop-filter`) is used where content genuinely passes
underneath — the topbar — and nowhere as an effect for its own sake.

## Shapes

`--radius-sm` (6px) for controls and chips, `--radius` (10px) for cards and
panels, `--radius-lg` (14px) for modals. Borders are 1px `--line`, moving to
`--line-strong` on hover.

## Components

**Icons** come from `web/src/components/Icon.tsx`: one 24-unit box, 1.75 stroke,
round caps and joins, sized in `em` and drawn in `currentColor`. Add to that file
rather than importing a second set. Generate geometry that must be symmetric
(the gear's teeth are computed on a circle) instead of typing coordinates —
transcribed paths fail at 17px in ways that are invisible in the source.

**State** is a dot, a badge, or a word — never a coloured edge down the side of a
card. Colour is never the only signal: the tile that shows a warn dot also says
what happened in text.

**Buttons** state their action. The primary action on a surface is filled with
`accent`; everything else is quiet until hovered.

**Dragging**: whole objects are grabbable, not a small handle, and the cursor
says `grab`/`grabbing` across the entire target. A drag must be *visible while
it happens* — a change that only lands on release reads as an interface that
ignored you.

## Do's and Don'ts

**Do**

- Add a token when you need a new value; reach for the next step on an existing
  scale before inventing one.
- Give every interactive element hover, focus-visible, disabled and loading
  states, and write the empty state as carefully as the full one.
- Keep motion to `--ease` (exponential ease-out) at `--fast`/`--base`/`--slow`,
  and honour `prefers-reduced-motion` — the colour change alone must still carry
  the meaning.
- Look at the result in a browser at real size before calling it done. Several
  defects in this file's history — an icon breaking to its own line, a gear
  rendering as an asterisk, a curve flattening into a diagonal scratch — were
  invisible in the source and obvious on screen.

**Don't**

- Use a Unicode glyph or emoji as an icon. They come from different typefaces
  with different weights and baselines, so a row of them reads as a row of
  accidents, and colour emoji ignore the theme entirely.
- Put a coloured `border-left` above 1px on a card, list item or callout.
- Add a blanket rule after state rules for the same element — it wins by coming
  later and silently flattens every state to one colour.
- Use `display: block` on an icon; it belongs inline as often as it belongs in a
  flex row.
- Introduce a second accent, a second icon set, or a second spacing rhythm.
- Reach for a modal where the task needs neither interruption nor protected
  focus.

---
name: tailwind-css-variable-theme-removal-causes-white-inputs
description: When removing CSS custom property theme tokens (RGB channels) from a Tailwind project, input fields become white-on-white — text and background both render as white because the CSS variables resolve to empty
source: auto-skill
extracted_at: '2026-06-06T09:50:00.000Z'
---

## The problem

After a theme system redesign that removes CSS custom properties (e.g., `--color-bg`, `--color-text`) from `globals.css`, text inputs become unreadable — white text on white background.

## Root cause

The old design used RGB-channel CSS variables consumed by Tailwind with opacity modifiers:

```css
:root {
  --color-bg: 2 6 23;
  --color-text: 248 250 252;
}
```

Tailwind config referenced them:
```js
colors: {
  bg: 'rgb(var(--color-bg) / <alpha-value>)',
  text: 'rgb(var(--color-text) / <alpha-value>)',
}
```

Components used classes like `bg-bg text-text`. These resolved to actual RGB values via the CSS variables.

When the CSS variables are removed (replaced by a hardcoded dark theme like `#05050A`), Tailwind classes referencing `rgb(var(--color-bg) / ...)` resolve to `rgb( / ...)` — which is invalid CSS. Browsers treat invalid color values as transparent or inherit, often defaulting to white in dark-mode contexts.

The result: inputs that had `bg-bg text-text` now have transparent backgrounds with white text, or white backgrounds with white text.

## How to diagnose

1. Open DevTools, inspect the input
2. Check computed `background-color` — if it's `transparent` or white when it should be dark, the CSS variable resolution is broken
3. Look for `rgb(var(--` in the computed styles — this indicates dead CSS variable references

## How to fix

Replace all `rgb(var(--color-*))` references with hardcoded hex values. For inputs specifically, use explicit colors:

```css
.input-glass {
  color: #dbe4e3 !important;
  background-color: rgba(0, 0, 0, 0.2) !important;
}
.input-glass::placeholder {
  color: rgba(185, 202, 201, 0.5) !important;
}
```

The `!important` is necessary when other Tailwind utility classes (like `text-on-surface`) are competing and may still reference dead CSS variables.

Also fix `<select>` element options which render in native OS dropdowns:

```css
.input-glass option {
  color: #dbe4e3;
  background-color: #0d1515;
}
```

## Prevention

When removing CSS custom properties that feed Tailwind's `rgb(var(--x) / <alpha>)` pattern, always:
1. Run a grep for `rgb(var(--` in all CSS/JSX files
2. Test every input, select, and textarea immediately after the change
3. Check both light and dark states if theme toggling is supported

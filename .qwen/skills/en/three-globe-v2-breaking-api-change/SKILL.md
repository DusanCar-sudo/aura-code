---
name: three-globe-v2-breaking-api-change
description: 'three-globe' v2.x changed atmosphere/globe configuration from method chaining to property setters — `.atmosphereDayIncrement is not a function` at runtime
source: auto-skill
extracted_at: '2026-06-06T09:44:00.000Z'
---

`three-globe` v2.x (published around 2025) changed how globe properties are configured. The old v1 API used fluent method chaining; v2 uses property setters on the instance.

## The breakage

Old v1 code that fails silently or crashes:

```js
globe = new ThreeGlobe()
  .showAtmosphere(true)           // ❌ v2: returns undefined, chain breaks
  .atmosphereColor('#3b82f6')     // ❌ TypeError on undefined
  .atmosphereDayIncrement(0.1)    // ❌ "is not a function"
```

The error message is: `TypeError: (intermediate value).showAtmosphere(...).atmosphereColor(...).atmosphereDayIncrement is not a function`

## The fix — v2 property setters

```js
globe = new ThreeGlobe()
globe.showAtmosphere = true
globe.atmosphereColor = '#14fbfb'
// atmosphereDayIncrement is removed in v2 — atmosphere altitude is implicit
```

## Defense-in-depth

Wrap atmosphere configuration in try/catch so the globe still renders even if the API shifts again:

```js
try {
  globe.showAtmosphere = true
  globe.atmosphereColor = '#14fbfb'
} catch (e) {
  // atmosphere is cosmetic — globe renders fine without it
}
```

## Why this matters

The `three-globe` package has gone through breaking changes between major versions. Projects that were built with v1.x will crash at runtime after a dependency update or fresh install pulls v2.x. The npm registry always serves the latest compatible version unless pinned, so `npm install` in a new environment will get v2. The error appears in the browser console (renderer) or Electron main process at component mount time.

## How to apply

1. Search for method-chained `new ThreeGlobe()` calls:
   ```bash
   grep -r "\.showAtmosphere\|\.atmosphereColor\|\.atmosphereDayIncrement" src/
   ```
2. Replace with property setter pattern shown above
3. Add try/catch wrapper for resilience
4. Run `npx vite build` to verify

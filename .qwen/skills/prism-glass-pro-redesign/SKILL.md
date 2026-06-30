---
name: prism-glass-pro-redesign
description: Complete procedure for applying Prism Glass Pro glassmorphism theme to a Tailwind/React/Electron app
source: auto-skill
extracted_at: '2026-06-06T10:38:00.000Z'
---

# Prism Glass Pro Redesign

## When to use
When transforming a Tailwind + React app to a dark glassmorphism aesthetic with cyan/purple neon accents, frameless window, Material Symbols icons, and Three.js globe.

## Core colors
- `background-deep`: `#05050A`
- `primary-fixed` (cyan): `#14fbfb`
- `secondary-container` (purple): `#7000ff`
- `accent-magenta`: `#FF0055`
- `status-success`: `#4ade80`
- `on-surface` (text): `#dbe4e3`
- `on-surface-variant` (muted): `#b9cac9`
- `text-muted`: `#8B949E`
- `border-glass`: `rgba(255, 255, 255, 0.15)`
- `surface-glass`: `rgba(255, 255, 255, 0.05)`
- `surface-glass-hover`: `rgba(255, 255, 255, 0.1)`

## Essential CSS classes (globals.css)
```css
.glass-panel { background: rgba(255,255,255,0.05); backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.15); }
.glass-header { same as glass-panel but border-bottom }
.glass-nav { same as glass-panel but border-right }
.shimmer { position:relative; overflow:hidden; }
.shimmer::after { content:''; position:absolute; top:0; left:-150%; width:50%; height:100%; background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent); animation:shimmer 4s infinite linear; }
.input-glass { color:#dbe4e3 !important; background-color:rgba(0,0,0,0.2) !important; border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:0.5rem 1rem; font-family:'Outfit',sans-serif; }
.input-glass:focus { border-color:rgba(20,251,251,0.5); box-shadow:0 0 0 3px rgba(20,251,251,0.1); }
.btn-cyan { background:#14fbfb; color:#002020; box-shadow:0 0 20px rgba(20,251,251,0.4); border-radius:12px; padding:0.5rem 1rem; font-weight:600; }
.btn-glass { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.15); color:#b9cac9; }
.nav-link { color:rgba(185,202,201,0.7); font-weight:500; padding:12px 16px; border-radius:12px; }
.nav-link:hover { background:rgba(255,255,255,0.1); color:#dbe4e3; }
.nav-link.active { background:rgba(255,255,255,0.1); color:#14fbfb; border-right:2px solid #14fbfb; }
.badge-glass { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#b9cac9; text-transform:uppercase; font-size:10px; }
.badge-cyan { background:rgba(20,251,251,0.1); border-color:rgba(20,251,251,0.2); color:#14fbfb; }
.status-dot { width:8px; height:8px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; }
.drag-region { -webkit-app-region:drag; }
.drag-region button,.drag-region input,.drag-region select,.drag-region a { -webkit-app-region:no-drag; }
```

## Prism background effect
```html
<div class="prism-bg">
  <div class="prism-glow-1" />  <!-- cyan radial gradient, blur(80px), pulse-glow animation -->
  <div class="prism-glow-2" />  <!-- purple radial gradient, blur(80px), pulse-glow reverse -->
</div>
```
Both `.prism-glow-1` and `.prism-glow-2` use `position:absolute` with large radial gradients and blur. Animated with `@keyframes pulse-glow`.

## Fonts (in index.html)
```html
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
```

## Icon migration: Lucide → Material Symbols
Replace all `lucide-react` imports with Material Symbols spans:
```jsx
<span className="material-symbols-outlined">icon_name</span>
```
Common mappings: Clipboard→content_copy, MessageSquare→chat, Zap→bolt/auto_awesome, Star→star, Settings→settings, Trash2→delete, Plus→add, Search→search, X→close, Camera→camera, Info→info, ExternalLink→open_in_new

## Frameless Electron window
In `electron/main.js` BrowserWindow config:
```js
frame: false,
titleBarStyle: 'hidden',
```
Add `.drag-region` CSS to header for window dragging, with `no-drag` on interactive elements.

## Three.js Globe integration
- Dependencies: `three`, `three-globe`
- Render at high resolution (300×300) then CSS `transform:scale()` down to desired display size
- Add arc lines, orbit ring, and glow points for visual appeal
- Use `try/catch` for atmosphere API (three-globe v2 uses setters: `globe.showAtmosphere = true`)
- Wrap in container with `drop-shadow` filter for cyan glow

## Tailwind config additions
Add all Prism colors as custom colors, Outfit/JetBrains Mono as font families, display-lg/headline-md/body-lg/body-sm/label-xs/code-snippet font sizes, and glow shadows.

## Key mistakes to avoid
- Never use old CSS variable classes (`bg-surface`, `border-border/50`, `card`, `text-text`, `text-text-muted`, `badge-text`, `badge-code`, `input-field`)
- Don't import lucide-react anywhere
- Frame must be `false` to avoid double title bar
- Input text needs explicit `color` (white-on-white happens without `!important`)
- Globe positioning: use absolute positioning outside flex flow to avoid overflow clipping
- Transform pages must replace all old class references (SmartPastePage textareas, selects, labels)

---
name: frameless-electron-window-with-drag-region
description: Remove native title bar double-rendering in Electron by setting `frame: false` and using CSS `-webkit-app-region` for window dragging
source: auto-skill
extracted_at: '2026-06-06T09:50:00.000Z'
---

## The problem

An Electron app renders custom window controls (minimize/maximize/close) in its React UI, but the native OS title bar also shows — producing **duplicate window controls** (two sets of minimize/maximize/close buttons).

## The fix — two parts

### Part 1: Electron main process — hide native frame

In `electron/main.js`, set `frame: false` and `titleBarStyle: 'hidden'`:

```js
mainWindow = new BrowserWindow({
  // ...
  frame: false,              // removes OS title bar entirely
  titleBarStyle: 'hidden',   // macOS: hides title bar but keeps traffic lights
  // ...
})
```

After this change, the window has no native drag handle — the user cannot move it by clicking the title area. This requires Part 2.

### Part 2: CSS drag region — make the custom header draggable

In the global CSS:

```css
.drag-region {
  -webkit-app-region: drag;      /* whole region is draggable */
}
.drag-region button,
.drag-region input,
.drag-region select,
.drag-region a {
  -webkit-app-region: no-drag;   /* interactive elements remain clickable */
}
```

Apply to the header element:

```jsx
<header className="... drag-region">
  <button className="...">Menu</button>
  <input className="..." />
</header>
```

**Why `no-drag` on children:** Without it, buttons and inputs inside the drag region become unclickable — all mouse events are captured by the drag handler instead of the interactive element.

## How to apply

1. Set `frame: false` in BrowserWindow config
2. Add `.drag-region` CSS utility class
3. Add `drag-region` class to the header/title-bar component
4. Restart Electron (main process changes require full restart, not HMR)
5. Test: clicking the header area should move the window; clicking buttons/inputs inside it should work normally

## Edge cases

- **macOS traffic lights**: With `titleBarStyle: 'hidden'`, macOS still shows the red/yellow/green dots. If your custom header overlaps them, add left padding (~70px on macOS).
- **Double-click to maximize**: Works automatically with the drag region on Windows/Linux.
- **Context menu on drag region**: Right-click on the drag region may show the system window menu — this is expected behavior.

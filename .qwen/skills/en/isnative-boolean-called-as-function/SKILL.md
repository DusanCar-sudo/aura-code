---
name: isNative-boolean-called-as-function
description: When a utility exports a boolean constant but a component imports and calls it as a function — `isNative()` instead of `isNative` — causes "is not a function" at render time
source: auto-skill
extracted_at: '2026-06-06T09:50:00.000Z'
---

## The trap

A platform detection utility exports a boolean value (not a function):

```js
// src/utils/platform.js
export const PLATFORM = {
  isNative: typeof window !== 'undefined' && !!window.Capacitor,
}
export const isNative = PLATFORM.isNative  // ← boolean, not a function
```

But a component imports and calls it like a function:

```jsx
// Dashboard.jsx
import { isNative } from '../utils/platform.js'
// ...
{isNative() && (   // ❌ TypeError: isNative is not a function
  <CameraButton />
)}
```

**Why this is deceptive:** A *different* file (`nativeAPI.js`) exports `isNative` as an actual function, and other files (`electronAPI.js`) import from there correctly. So `isNative()` works in some places and crashes in others, depending on which file provides the import.

## How to diagnose

1. The error points to a specific line: `TypeError: isNative is not a function at Dashboard (Dashboard.jsx:141:10)`
2. Check the import source — it traces to `platform.js`, not `nativeAPI.js`
3. Read the export: `export const isNative = PLATFORM.isNative` — it's a property access, not a function

## How to fix

Change `isNative()` to `isNative` (remove parentheses):

```jsx
{isNative && (   // ✅ boolean check, no function call
  <CameraButton />
)}
```

## Prevention

When a codebase has two modules exporting the same name but different types, use `grep` to audit all callers before renaming or refactoring:

```bash
grep -rn "isNative()" src/
```

If some callers import from a module where it IS a function and others from where it's a boolean, pick a consistent name (e.g., rename the boolean to `IS_NATIVE` or the function to `checkIsNative`).

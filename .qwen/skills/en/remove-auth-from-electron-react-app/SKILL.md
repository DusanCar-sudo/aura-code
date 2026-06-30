---
name: remove-auth-from-electron-react-app
description: Systematically remove Firebase auth & cloud sync from an Electron + React app — trace dependencies across renderer, main process, and preload bridge
source: auto-skill
extracted_at: '2026-06-05T18:40:16.459Z'
---

When removing a cross-cutting concern like Firebase authentication + cloud sync from an Electron + React app, the dependency spans three architectural layers that must each be addressed:

1.  **Renderer process** (React): services, stores, components, pages
2.  **Main process** (Electron): IPC handlers, CSP headers, `BrowserWindow` popup/open handlers, navigation allow-lists
3.  **Preload bridge**: `contextBridge.exposeInMainWorld` entries that expose auth IPC to the renderer

**Why:** Deleting just the Firebase service file (`firebase.js`) leaves dangling imports in stores (Zustand), UI components (header, settings), layout init calls, and IPC handlers in the Electron main process. The app will crash at import-time or fail silently with broken UI. Each layer must be traced and cleaned.

**How to apply:**

### Step 1 — Map all touchpoints with grep
```bash
grep -r "firebase\|googleSignIn\|authStore\|onAuthChange" src/ electron/
```

### Step 2 — Clean renderer layer (top-down)
- **Service file** (`src/services/firebase.js`): delete entirely
- **Auth store** (`src/store/authStore.js`): delete entirely (Zustand store that wraps Firebase auth)
- **Stores that call Firebase** (e.g. `clipboardStore.js`): remove imports (`auth`, `syncClipToCloud`, `deleteClipFromCloud`), remove helper (`getCloudUser`), remove cloud-sync blocks inside `addItem`/`updateItem`/`deleteItem`
- **Layout components** (`Layout.jsx`, `MobileLayout.jsx`): remove `useAuthStore` import, `initAuth()` call, and unsubscribe cleanup
- **Header component**: remove Firebase auth imports, user state, login/logout handlers, user avatar/menu UI, Sync button
- **Settings page**: remove entire Account & Cloud Sync section, remove `useAuthStore` usage, update data-section text that references cloud sync
- **Icon imports**: remove Lucide icons that were only used in the auth UI (`Cloud`, `CloudOff`, `LogOut`, `User`)

### Step 3 — Clean main process (`electron/main.js`)
- Remove `require('./google-auth')` and any direct auth module usage
- Remove auth IPC handler: `ipcMain.handle('auth:google-signin', ...)`
- Strip Firebase/Google domains from CSP `frame-src` directive
- Simplify `setWindowOpenHandler` — remove Firebase/Google popup allow-lists; route all external URLs to `shell.openExternal`
- In `web-contents-created` listener: remove Firebase/Google from `allowedUrls` in `will-navigate` handler and from the `setWindowOpenHandler` block

### Step 4 — Clean preload bridge (`electron/preload.js`)
- Remove `googleSignIn: () => ipcRenderer.invoke('auth:google-signin')` from `contextBridge.exposeInMainWorld`

### Step 5 — Remove static config and dependencies
- Delete: `firebase.json`, `.firebaserc`, `firestore.rules`, `electron/google-auth.js`
- Edit `package.json`: remove `"firebase": "..."` line
- Run: `npm uninstall firebase`

### Step 6 — Verify
```bash
grep -r "firebase\|authStore\|googleSignIn" src/ electron/   # should be empty
npx vite build                                                # should compile cleanly
```

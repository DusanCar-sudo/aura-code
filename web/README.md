# Aura Web Client

> **The Single-Window Workspace for Autonomous Software Engineering.**

A zero-friction, model-agnostic graphical environment that speaks the unified `aura sidecar` protocol over WebSockets.

---

## Core Philosophy

### 🪟 The Single-Window Paradigm
The core philosophy of Aura Web is absolute consolidation: you open the application, you do your work, and you never have to leave. It eliminates the friction of context-switching by bringing every phase of your software creation lifecycle into one unified interface.

### ⚡ End-to-End Execution
A complete, self-contained workspace. With a native code editor and integrated terminal environment built directly into the UI, you can write, edit, compile, and execute code without juggling external windows, IDE tabs, or separate terminal monitors.

### 🔀 Agnostic AI Control
Designed for ultimate operational flexibility. Effortlessly route agent tasks across 31+ routing targets and model endpoints (Anthropic Claude, OpenAI GPT, Google Gemini, Xiaomi MiMo, Zhipu GLM, or local Ollama instances) without breaking flow or restarting sessions.

### 💡 The Competitive Differentiator
What puts Aura Web ahead is this dense concentration of utility. By providing an extensive, high-velocity suite of tools inside a single, focused window, it removes the disjointed clutter of modern dev setups. You get everything required to execute every stage of your work from one place.

---

## Technical Highlights & Features

- **Protocol Parity:** Connects directly to `aura serve` via WebSocket streaming (`lib/protocol.ts`), exposing full session control, streaming deltas, approvals, and execution state.
- **Ultra-Slim Desktop Ready:** Built with React 18 + Vite targeting dual delivery: served directly over HTTP/WS via `aura serve`, or wrapped in a lightweight **Tauri** desktop container (single-digit MB footprint, no Electron overhead).
- **Hand-Crafted Design System:** Zero utility framework bloat. Hand-written CSS custom properties derived directly from Aura's CLI diamond palette (`src/cli/diamond.ts`).
- **I18n Engine:** Out-of-the-box support for 7 locales, including full right-to-left (RTL) flow for Arabic using CSS logical properties.
- **XSS & Security Hardened:** Strict Markdown sanitization with raw HTML execution disabled, paired with `httpOnly; SameSite=Strict` cookie pairing authentication.

---

## Quickstart

### Development & Serving

```bash
# Build the TypeScript engine and web bundle
npm run build

# Start the local server with session pairing token
aura serve

# Or run the Vite dev server with proxying (:5273 -> :4317)
npm run dev:web
```

---

## Workspace Architecture

```
web/
├── src/
│   ├── lib/protocol.ts     # Resilient WebSocket peer with promise multiplexing
│   ├── hooks/useAura.ts    # Single source of truth for sessions, deltas, tool approvals
│   ├── components/         # Workspace, Sidebar, Chat, Terminal, Canvas, Settings
│   ├── styles/             # Hand-crafted design system, theme tokens, and typography
│   └── i18n/               # Multi-language translation engine (7 locales + RTL)
└── vite.config.ts          # Optimized build pipeline with content hashing
```

---

## System Capabilities Matrix

| Feature / Control | Integration Status |
|---|---|
| Real-time Token & Markdown Streaming | ✅ Fully Operational |
| Multi-Turn Tool Call Approvals & Inspections | ✅ Fully Operational |
| Session Multiplexing & Conversation Search | ✅ Fully Operational |
| Model, Token Budget & Turn Limit Tuning | ✅ Fully Operational |
| Granular Permission Enforcement | ✅ Enforced via `session.create.permission` |
| Local Skill & Plugin Capabilities | 🟡 Read-only listing via `/api/skills` |
| Sandboxed Host Isolation | ⚙️ Designed (`docs/SANDBOX-DESIGN.md`) |

---

## Security Model

- **Content Hashing:** Hard cache control on static bundles paired with `no-store` headers on `index.html` prevents stale assets across updates.
- **Session Authentication:** Authenticates via secure token pairing URL parameter that sets a scoped `httpOnly; SameSite=Strict` session cookie.
- **Strict Rendering Isolation:** Output markdown is scrubbed of all script/style/event handler vectors prior to DOM injection.

---

*Architected & Built by Dušan Milosavljević — Da Nang, Vietnam*

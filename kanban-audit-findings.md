# Stage 1: Audit Findings

## What exists in `aura-code/src/kanban/`

### `types.ts` (122 lines)
- Defines `KanbanCard`, `KanbanBoard`, `KanbanTask`, `PipelinePhase`, `PipelineRow`, `TaskStatus`, `PhaseResult`, `TaskExecution`, `PipelineReport`, `RowReport`, `ProgressEvent`.
- Two parallel type systems: a generic card/board model (`KanbanCard`, `KanbanBoard`) and a pipeline-specific model (`KanbanTask`, `PipelineReport`).
- `KanbanCard` is the simpler, reusable type — has `id`, `title`, `column`, `priority`, `tags`, timestamps.
- `KanbanTask` is pipeline-specific — tied to `PipelinePhase` and `PipelineRow`.

### `engine.ts` (175 lines)
- JSON-file backed CRUD engine (`~/.aura/kanban.json`).
- `addCard`, `moveCard`, `updateCard`, `deleteCard`, `getCard`, `listCards`, `clearBoard`, `addColumn`, `removeColumn`, `stats`.
- **Highly reusable** — this is exactly the storage layer a standalone kanban server needs. Zero external deps.

### `pipeline.ts` (974 lines)
- Full pipeline execution engine: Read → Plan → Execute → Verify → Report.
- Hardcoded `BOARD_TASKS` array with 20+ tasks tied to aura-code internals (token optimization, cross-provider prompts, etc.).
- **Not reusable** for a generic kanban server — too coupled to aura-code's specific pipeline logic.

### `server.ts` (824 lines)
- Express + WebSocket server serving the pipeline board.
- Routes: `GET /` (HTML board), `GET /api/tasks`, `POST /api/execute`, `GET /api/report`.
- **Partially reusable** — the Express/WS pattern is good, but the API is pipeline-specific. The HTML board builder (`buildKanbanUI`) is a useful reference.

### `index.ts` (10 lines)
- Simple barrel export.

## What exists in Ruby Diamond Client (`~/ruby-diamond-client/`)

### Frontend (React + TypeScript + Vite + Zustand)
- `App.tsx`: Main layout with sidebar, explorer, editor, chat, mesh, llama, plugins, memory, sysadmin panels.
- `store.ts`: Zustand store — manages tabs, files, agent state, mesh results, llama status, plugins.
- `components/`: 14 components — Splash, Sidebar, Explorer, Editor, Chat, AgentTabs, MeshPanel, LlamaPanel, PluginPanel, MemoryPanel, SysAdminPanel, SystemPanel, Terminal.
- `lib/api.ts`: Tauri `invoke`-based API client — wraps all Rust commands.
- `lib/tauri.ts`: Tauri detection utility.
- `lib/provider.ts`: LLM provider catalog.
- `styles.css`: Full design system (terracotta/clay/cream/charcoal/coral).

### Backend (Rust + Tauri v2)
- `lib.rs`: App setup, registers all commands.
- `commands.rs`: 15+ Tauri commands — file ops, agent control, tool/skill management.
- `mesh/mod.rs`: AgentMesh orchestration — debate, review, ensemble patterns.
- Pattern: Tauri commands are registered in `lib.rs`, implemented in their own modules, called from React via `invoke()`.

## What's reusable vs what needs building

| Component | Reusable? | Notes |
|-----------|-----------|-------|
| `engine.ts` (CRUD) | ✅ Yes | JSON-file backed, zero deps, generic card model. Perfect base. |
| `types.ts` (KanbanCard) | ✅ Yes | `KanbanCard` type is generic enough. |
| `types.ts` (KanbanTask) | ❌ No | Too pipeline-specific. |
| `pipeline.ts` | ❌ No | Hardcoded aura-code tasks. |
| `server.ts` (Express/WS) | ⚠️ Partial | Pattern is good, but needs new API surface. |
| RDC `store.ts` | ⚠️ Partial | Zustand pattern is good, needs kanban slice. |
| RDC `api.ts` | ⚠️ Partial | Needs kanban invoke wrappers. |
| RDC `lib.rs` | ⚠️ Partial | Needs kanban Tauri commands registered. |
| RDC `commands.rs` | ❌ No | No kanban commands exist. |

## Key design decisions for the new server

1. **Standalone Node.js server** (not embedded in Tauri) — any agent can call it via HTTP, not just the RDC frontend.
2. **Use `engine.ts` as the storage layer** — it's already generic and zero-dependency.
3. **Minimal API** — just `POST /api/move` with `{ cardId, column, reason }` as the core agent-facing endpoint.
4. **MCP tool wrapper** — follow AgentMesh's pattern for agent-agnostic access.
5. **RDC frontend** — add a new KanbanPanel component that polls the standalone server.
6. **WebSocket for live updates** — agents push moves, GUI receives them in real-time.

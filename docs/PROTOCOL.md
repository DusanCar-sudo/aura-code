# Aura engine protocol

One message schema, two transports. This document is the source of truth;
`src/protocol/types.ts` mirrors it in TypeScript and both transport adapters
are deliberately thin so they cannot drift into different protocols.

| Transport | Command | Framing | Clients |
|---|---|---|---|
| stdio | `aura sidecar` | newline-delimited JSON, one frame per line | `aura-mathetes` (Tauri spawns it as a child process) |
| WebSocket | `aura serve` | one frame per WS message | `aura-droid`, any remote client |

Android cannot reliably spawn and supervise a native child process, so
`aura-droid` connects to the existing `aura serve` socket. Tauri can, so
Mathetes uses the sidecar and gets no listening port, no bearer token, and no
network attack surface — the OS process boundary is the trust boundary.

`aura serve` keeps its own older `type:`-tagged message format for the
browser UI it serves. The two are dispatched by shape on the same socket: a
message with `kind` is a protocol frame, a message with `type` is legacy.
New clients should only use frames.

---

## Frames

Three kinds. Both sides may send a request and both must answer one — that
symmetry is what makes tool approval work, since the engine asks the *client*
whether a tool may run and blocks on the reply.

### Request

```json
{ "kind": "req", "id": "1", "method": "session.create", "params": { "projectRoot": "/home/u/proj" } }
```

`id` is unique per sender and echoed on the response. Requests from the
engine use UUIDs; a client may use whatever it likes.

### Response

```json
{ "kind": "res", "id": "1", "ok": true, "result": { "sessionId": "9f3c…" } }
```

```json
{ "kind": "res", "id": "1", "ok": false, "error": { "code": "no_such_session", "message": "No such session: 9f3c" } }
```

### Event

One-way, never answered. `sessionId` is present on everything except
engine-wide events such as `engine.ready`.

```json
{ "kind": "evt", "method": "turn.delta", "sessionId": "9f3c…", "params": { "turnId": "77a1…", "text": "Reading " } }
```

### Error codes

| Code | Meaning |
|---|---|
| `bad_frame` | Unparseable, or `kind` is not `req`/`res`/`evt` |
| `unknown_method` | No such method |
| `bad_params` | Missing or wrong-typed parameter |
| `no_such_session` | Unknown `sessionId` |
| `session_busy` | A turn is already running on that session |
| `budget_exhausted` | The session's token ceiling is spent |
| `provider_error` | The model provider rejected the call |
| `internal` | Unexpected engine fault |

A malformed line does not kill the connection — the engine answers
`bad_frame` (with `id: ""` when the id could not be read) and continues.

---

## Client → engine methods

Shapes mirror `aura-mathetes`' existing `#[tauri::command]` surface so the
Tauri rewrite is mechanical:

| Tauri command | Protocol method |
|---|---|
| `create_agent` | `session.create` |
| `run_agent` | `turn.send` |
| `get_agent_messages` | `session.history` |
| `list_tools` | `tools.list` |
| `get_workspace_state` | `session.state` |
| — | `session.list`, `session.destroy`, `turn.cancel`, `usage.get` |

### `session.create`

Creates an isolated session. `projectRoot` scopes session storage, memory,
and every file tool — two sessions on different roots cannot see each
other's history or search each other's files.

```json
{ "kind": "req", "id": "1", "method": "session.create",
  "params": {
    "projectRoot": "/home/u/proj",
    "model": "deepseek/deepseek-v4-flash",
    "apiKey": "sk-…",
    "baseUrl": "https://api.example.com/v1",
    "name": "Aura",
    "maxInputTokens": 200000
  } }
```

Every field except `projectRoot` is optional; omitted ones fall back to the
engine's configured defaults. `maxInputTokens` sets this session's own
ceiling (see [Budget](#budget)).

```json
{ "kind": "res", "id": "1", "ok": true,
  "result": { "sessionId": "9f3c…", "projectRoot": "/home/u/proj", "model": "deepseek/deepseek-v4-flash", "name": "Aura" } }
```

### `session.destroy`

```json
{ "kind": "req", "id": "2", "method": "session.destroy", "params": { "sessionId": "9f3c…" } }
{ "kind": "res", "id": "2", "ok": true, "result": { "destroyed": true } }
```

Aborts any running turn.

### `session.list`

```json
{ "kind": "req", "id": "3", "method": "session.list", "params": {} }
{ "kind": "res", "id": "3", "ok": true, "result": { "sessions": [
  { "sessionId": "9f3c…", "name": "Aura", "projectRoot": "/home/u/proj",
    "model": "deepseek/deepseek-v4-flash", "createdAt": 1785241896034,
    "busy": false, "turnsUsed": 4, "inputTokensUsed": 3096 }
] } }
```

### `session.history`

Full conversation, including tool calls and results.

```json
{ "kind": "req", "id": "4", "method": "session.history", "params": { "sessionId": "9f3c…" } }
{ "kind": "res", "id": "4", "ok": true, "result": { "messages": [
  { "role": "user", "content": "Run the shell command: echo hi > proof.txt" },
  { "role": "assistant", "content": "", "toolCalls": [
    { "id": "call_00…", "name": "run_shell", "input": { "command": "echo hi > proof.txt" } } ] },
  { "role": "tool_result", "results": [
    { "id": "call_00…", "name": "run_shell", "content": "(command completed with no output)", "isError": false } ] }
] } }
```

### `session.state`

Everything a client needs to render a workspace in one call —
`get_workspace_state`'s replacement.

```json
{ "kind": "req", "id": "5", "method": "session.state", "params": { "sessionId": "9f3c…" } }
{ "kind": "res", "id": "5", "ok": true, "result": {
  "sessionId": "9f3c…", "name": "Aura", "projectRoot": "/home/u/proj",
  "model": "deepseek/deepseek-v4-flash", "busy": false, "messageCount": 8,
  "tools": [ { "name": "read_file", "description": "…", "parameters": { "type": "object" } } ],
  "usage": { "inputTokensUsed": 3096, "maxInputTokens": 200000, "turnsUsed": 4, "exhausted": false }
} }
```

### `turn.send`

Starts a turn. **The response returns immediately with a `turnId`; the work
arrives as events.** A client that waits for the response before reading
events will deadlock, because the engine may ask for approval mid-turn and
blocks until the client answers.

```json
{ "kind": "req", "id": "6", "method": "turn.send",
  "params": { "sessionId": "9f3c…", "message": "Add a health check endpoint" } }
{ "kind": "res", "id": "6", "ok": true, "result": { "turnId": "77a1…" } }
```

One turn per session at a time; a second concurrent `turn.send` gets
`session_busy`. Different sessions may run turns concurrently.

### `turn.cancel`

```json
{ "kind": "req", "id": "7", "method": "turn.cancel", "params": { "sessionId": "9f3c…" } }
{ "kind": "res", "id": "7", "ok": true, "result": { "cancelled": true } }
```

`cancelled` is `false` when nothing was running. The turn still emits
`turn.completed`.

### `tools.list`

```json
{ "kind": "req", "id": "8", "method": "tools.list", "params": {} }
{ "kind": "res", "id": "8", "ok": true, "result": { "tools": [
  { "name": "read_file", "description": "Read file contents with line numbers…",
    "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } }
] } }
```

`parameters` is JSON Schema, passed through unchanged from the engine's tool
definitions.

### `usage.get`

```json
{ "kind": "req", "id": "9", "method": "usage.get", "params": { "sessionId": "9f3c…" } }
{ "kind": "res", "id": "9", "ok": true, "result":
  { "inputTokensUsed": 3096, "maxInputTokens": 200000, "turnsUsed": 4, "exhausted": false } }
```

`maxInputTokens` is `null` when the session is uncapped.

---

## Engine → client requests

### `approval.request`

The engine asks permission before running a gated tool and **blocks the turn
until the client answers**.

```json
{ "kind": "req", "id": "0bf5…", "method": "approval.request",
  "params": {
    "sessionId": "9f3c…",
    "tool": "run_shell",
    "args": { "command": "echo hi > proof.txt" },
    "tier": 3,
    "rendered": "Allow: $ echo hi > proof.txt?"
  } }
```

`tool` and `args` are structured — a client renders its own modal rather
than parsing `rendered`, which is human prose formatted for a terminal.

The client answers with a normal response frame:

```json
{ "kind": "res", "id": "0bf5…", "ok": true, "result": { "decision": "allow" } }
```

| `decision` | Effect |
|---|---|
| `allow` | Run it once |
| `deny` | Block it; the agent is told the user denied it and continues |
| `allow_always_session` | Run it, and stop asking for that tool for the rest of the session |

**Deny is the default on anything else.** A timeout (120 s), a dropped
transport, an `ok: false` response, or an unrecognised `decision` all deny.
Silence is never consent.

### Tiers

`tier` is on the wire now so the Phase 5 guard does not change the format.
Until it lands the engine emits `3` for everything that reaches a
confirmation.

| Tier | Meaning |
|---|---|
| 1 | Auto — reads, searches, memory lookups |
| 2 | Accept-edits — writes inside the project root |
| 3 | Approval required — outside the root, installs, network, `git push`, credential paths, destructive shell |
| 4 | Bypass — not implemented |

---

## Engine → client events

| Method | `params` | When |
|---|---|---|
| `engine.ready` | `protocolVersion`, `defaultModel`, `defaultProjectRoot` | Once, on connect |
| `turn.started` | `turnId` | Turn begins |
| `turn.delta` | `turnId`, `text` | Assistant text, streamed |
| `turn.tool_call` | `turnId`, `name`, `input` | Model invoked a tool |
| `turn.tool_result` | `turnId`, `name`, `result`, `elapsedMs` | Tool returned |
| `turn.tool_blocked` | `turnId`, `name`, `reason` | Tool refused or denied |
| `turn.error` | `turnId`, `message` | Turn threw |
| `turn.completed` | see below | Turn ended, success or not |
| `log` | `turnId`, `level`, `message` | Engine diagnostics |

`turn.completed` always fires, including after `turn.error` and after a
cancel:

```json
{ "kind": "evt", "method": "turn.completed", "sessionId": "9f3c…",
  "params": {
    "turnId": "77a1…", "success": true,
    "summary": "Created /tmp/proof.txt with the content hello.",
    "turns": 4, "toolCount": 3,
    "usage": { "inputTokens": 11800, "outputTokens": 298, "cachedTokens": 8704, "costUsd": 0.000638736 },
    "budgetStopped": false
  } }
```

---

## Budget

Each session carries its own ceiling on cumulative **billed input tokens**
(raw prompt minus prompt-cache hits — cache hits bill at a fraction of the
standard rate, so counting them would stop a cheap well-cached session and an
expensive cold one at the same point).

- Default: `AURA_SESSION_BUDGET` if set, else 1,000,000.
- Per session: `maxInputTokens` on `session.create`.
- `AURA_SESSION_BUDGET=0` disables the ceiling. A malformed value falls back
  to the default rather than to unlimited — failing open on a typo is the one
  outcome this must never have.

The check is **predictive**: before each turn the engine measures the prompt
it is about to send and stops if it would cross the ceiling, rather than
noticing afterwards. Input is billed when the request is sent, so a
stop-after check saves nothing on the offending call. A turn that cannot fit
is never sent and `turn.completed` carries `budgetStopped: true`.

`turn.send` on an already-exhausted session is rejected outright with
`budget_exhausted`.

---

## Local model management

**Not part of this protocol.** Starting, stopping and discovering a local
`llama-server` is process supervision, and it stays on the Rust side in
`aura-mathetes` (`src-tauri/src/llamacpp/`). The engine only ever speaks HTTP
to a server that is already running — point a session at it with
`baseUrl` on `session.create`.

---

## Worked example

`scripts/protocol-test-client.mjs` is a runnable reference client: it spawns
`aura sidecar`, lists tools, opens a session, sends a message, answers the
approval request, and prints every frame in both directions.

```bash
node scripts/protocol-test-client.mjs \
  --model 'deepseek/deepseek-v4-flash' \
  --root /tmp/demo \
  --task "Run the shell command: echo hi > proof.txt"
```

Abridged transcript (`→` client to engine, `←` engine to client):

```
← {"kind":"evt","method":"engine.ready","params":{"protocolVersion":1,…}}
→ {"kind":"req","id":"1","method":"tools.list","params":{}}
← {"kind":"res","id":"1","ok":true,"result":{"tools":[…26 tools…]}}
→ {"kind":"req","id":"2","method":"session.create","params":{"projectRoot":"/tmp/demo",…}}
← {"kind":"res","id":"2","ok":true,"result":{"sessionId":"3e0f8be7…",…}}
→ {"kind":"req","id":"4","method":"turn.send","params":{"sessionId":"3e0f8be7…","message":"Run the shell command: echo hi > proof.txt"}}
← {"kind":"res","id":"4","ok":true,"result":{"turnId":"64a1cd24…"}}
← {"kind":"evt","method":"turn.started","params":{"turnId":"64a1cd24…"}}
← {"kind":"evt","method":"turn.tool_call","params":{"name":"run_shell","input":{"command":"echo hi > proof.txt"}}}
← {"kind":"req","id":"0bf5…","method":"approval.request","params":{"tool":"run_shell","args":{"command":"echo hi > proof.txt"},"tier":3,"rendered":"Allow: $ echo hi > proof.txt?"}}
→ {"kind":"res","id":"0bf5…","ok":true,"result":{"decision":"allow"}}
← {"kind":"evt","method":"turn.tool_result","params":{"name":"run_shell","result":"(command completed with no output)","elapsedMs":6}}
← {"kind":"evt","method":"turn.completed","params":{"success":true,"turns":4,"toolCount":3,…}}
```

---

## Implementation notes for client authors

- **Read events while a request is outstanding.** `turn.send` responds
  immediately and the turn's work arrives as events; the engine will issue
  an `approval.request` mid-turn and wait for it. A client that serialises
  all frames behind one in-flight request deadlocks — the engine's own stdio
  adapter had exactly this bug, and an `allow` came back as "denied by user"
  because the response sat in a queue behind the turn awaiting it.
- **stdout is the frame stream.** In sidecar mode nothing else may be
  written to it; the engine redirects its own `console.log` to stderr for
  this reason. Read stderr separately for diagnostics.
- **Match responses by `id`,** not by arrival order.
- **Answer `approval.request` promptly.** It denies after 120 s.

# Stage 2: Kanban API Contract

## Design Principles

1. **Minimal surface** — one endpoint for the core agent action (move a card).
2. **Structured diff** — card id, new column, short reason. Nothing more.
3. **Agent-agnostic** — no aura-code or Ruby Diamond specifics in the schema.
4. **Extensible** — additional endpoints (create, delete, list) follow the same pattern.

## Endpoints

### `POST /api/move`
Move a card to a new column. This is the primary agent-facing endpoint.

**Request:**
```json
{
  "cardId": "kb-a1b2c3d4",
  "column": "in-progress",
  "reason": "Starting implementation of token optimizer"
}
```

**Response (200):**
```json
{
  "ok": true,
  "card": {
    "id": "kb-a1b2c3d4",
    "title": "Token Optimization",
    "column": "in-progress",
    "updatedAt": "2026-07-16T21:30:00.000Z"
  }
}
```

**Response (404 — card not found):**
```json
{
  "ok": false,
  "error": "Card not found: kb-a1b2c3d4"
}
```

### `GET /api/board`
Get the full board state (for GUI rendering).

**Response (200):**
```json
{
  "columns": ["backlog", "todo", "in-progress", "review", "done"],
  "cards": [
    {
      "id": "kb-a1b2c3d4",
      "title": "Token Optimization",
      "description": "Parse multi-file dependencies...",
      "column": "in-progress",
      "priority": "high",
      "tags": ["Claude-3.5"],
      "createdAt": "2026-07-16T20:00:00.000Z",
      "updatedAt": "2026-07-16T21:30:00.000Z"
    }
  ]
}
```

### `POST /api/card`
Create a new card (agent or GUI can add tasks).

**Request:**
```json
{
  "title": "New Task",
  "column": "backlog",
  "description": "Optional description",
  "priority": "medium",
  "tags": ["agent"]
}
```

**Response (201):**
```json
{
  "ok": true,
  "card": { "id": "kb-5e6f7a8b", "title": "New Task", "column": "backlog", ... }
}
```

### `GET /api/events`
WebSocket endpoint for real-time board updates. Pushes a JSON message on every card move:

```json
{
  "type": "card_moved",
  "cardId": "kb-a1b2c3d4",
  "from": "todo",
  "to": "in-progress",
  "reason": "Starting implementation",
  "timestamp": "2026-07-16T21:30:00.000Z"
}
```

## Token Efficiency

The `POST /api/move` request body is ~80 bytes. The response is ~150 bytes.
This is intentionally tiny — an agent can include the move in its tool call output
without consuming meaningful context budget.

Compare to a verbose prompt template like:
> "I am moving card X from column Y to column Z because reason R. The card was previously in column Y and now it is in column Z. This move was triggered by..."

That verbose version is ~300+ bytes per move. Over 50 moves in a session, that's
~15KB of context saved. The structured diff approach saves ~220 bytes per move.

# Handoff: Wire RubyAlternator into aura-code CLI single-task path

## Context
`src/ruby/alternator.ts` defines a working `RubyAlternator` class (small-model-first,
escalate-to-large-model routing with episode capture). It is fully built but never
instantiated anywhere in the codebase — confirmed via:
```
grep -rn "new RubyAlternator" src --include="*.ts"
```
returns nothing.

## Task
Wire it into the **single-task, non-interactive path** in `src/cli/index.ts` —
the branch that runs when the CLI is invoked as `aura "<task>"` (not TUI, not
--architect, not orchestrated mode). This branch currently looks like:

```typescript
    let result;
    if (doVerify) {
      const { runWithVerification } = await import('../verify/index.js');
      // ... existing verify branch, do not touch ...
      result = wrapperResult.loopResult;
    } else {
      result = await runAgentLoop({
        provider, task, context: ctx, permissions, display,
        initialHistory: activeChatHistory,
        maxTurns: resolved.maxTurns,
        spawnConfig: {
          apiKey: argv['api-key'] ?? undefined,
          baseUrl: resolved.baseUrl ?? undefined,
        },
        sessionPath,
      });
    }
```

Find this exact block by searching for `if (doVerify) {` — there may be multiple
`runAgentLoop` call sites in this file (TUI mode, --architect blueprint mode,
orchestrated mode, etc). **Only modify the one immediately following the
`if (doVerify) { ... } else { ... }` structure shown above.** Do not touch
`runArchitectPlan()` or any REPL/TUI-mode call sites.

## Step 1 — Add import
Near the top of the file, next to the existing loop import:
```typescript
import { runAgentLoop } from '../agent/loop.js';
import { RubyAlternator, DEFAULT_RUBY_CONFIG } from '../ruby/index.js';
```

## Step 2 — Replace the `else` branch
Replace the `else { result = await runAgentLoop({...}); }` block shown above with:

```typescript
    } else if (fileConfig.ruby?.enabled) {
      const rubyConfig = {
        ...DEFAULT_RUBY_CONFIG,
        ...(fileConfig.ruby ?? {}),
      };
      const alternator = new RubyAlternator({
        rubyConfig,
        largeModelProvider: provider,
        projectRoot: ctx.root,
        context: ctx,
        display,
        permissions,
        initialHistory: activeChatHistory,
      });
      const altResult = await alternator.run(task);
      result = altResult.loopResult;
    } else {
      result = await runAgentLoop({
        provider, task, context: ctx, permissions, display,
        initialHistory: activeChatHistory,
        maxTurns: resolved.maxTurns,
        spawnConfig: {
          apiKey: argv['api-key'] ?? undefined,
          baseUrl: resolved.baseUrl ?? undefined,
        },
        sessionPath,
      });
    }
```

Verify `fileConfig` is already in scope at this point in the function (it's used
two lines below for `fileConfig.maxVerifyRetries` in the existing code) — if the
variable has a different name at this exact location, use that name instead.

Verify `RubyAlternator`'s constructor accepts exactly these fields — cross-check
against `AlternatorOptions` in `src/ruby/alternator.ts`:
```typescript
export interface AlternatorOptions {
  rubyConfig: RubyConfig;
  largeModelProvider: LLMProvider;
  projectRoot: string;
  context: ProjectContext;
  display?: Display;
  permissions?: PermissionSystem;
  confirmFn?: (message: string) => Promise<boolean>;
  initialHistory?: HistoryMessage[];
}
```

## Step 3 — Add config type (if not present)
Check whether the project's config type (wherever `fileConfig`'s type is defined,
likely `src/config/` or similar) already has a `ruby` field. If not, add:
```typescript
ruby?: {
  enabled?: boolean;
  modelName?: string;
  ollamaBaseUrl?: string;
  competenceThreshold?: number;
  minAttempts?: number;
};
```
to whatever interface `fileConfig` is typed as, so the `fileConfig.ruby?.enabled`
access in Step 2 type-checks cleanly.

## Step 4 — Add to .aura.json
In the project root (`/mnt/bigdata/aura/aura-code/.aura.json`), add:
```json
"ruby": {
  "enabled": true,
  "modelName": "qwen2.5-coder:1.5b",
  "ollamaBaseUrl": "http://localhost:11434/v1",
  "competenceThreshold": 0.7,
  "minAttempts": 3
}
```
as a top-level key alongside the existing config fields. Do not remove or
reorder existing keys.

## Step 5 — Verify
```bash
npx tsc --noEmit
```
Fix any type errors that surface — do not suppress with `any` or `@ts-ignore`.
Report the exact errors if something doesn't resolve cleanly rather than
guessing around it.

## Step 6 — Report back
Summarize:
- Exact line numbers changed in `src/cli/index.ts`
- Whether `fileConfig`'s type needed the `ruby` field added, and where
- `tsc --noEmit` output (clean or errors)
- Do NOT run `aura` against real tasks yet — a manual smoke test happens
  in a separate follow-up step, not part of this handoff.

## Rules (per project conventions)
- `git status --short` before any `git add`, never `git add -A`
- One story per commit — this is one commit: "wire RubyAlternator into CLI single-task path"
- Full file edits where practical, but this task is a targeted patch — surgical
  edit is correct here, not a full-file rewrite
- Do not touch `runArchitectPlan()`, TUI mode, or orchestrated mode call sites

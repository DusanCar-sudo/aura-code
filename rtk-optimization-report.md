# RTK Optimization Report — Aura Code

**Date:** 2026-07-29  
**Goal:** Reduce excessive token consumption (1.28M+ per session) in the Aura Code custom harness.

---

## 1. The Problem
While the **Rust Token Killer (RTK)** was installed on the machine, the Claude hook (`rtk hook claude`) only automatically proxies standard terminal usage. Because Aura Code uses Node.js native `child_process.exec()` and `execSync()` under the hood to run AI shell commands and Git operations, these commands were bypassing the RTK proxy entirely. 

As a result, massive uncompressed outputs from commands like `git diff`, `git log`, and `grep` were being directly injected into the AI's context window, causing exponential token bloat as the session progressed.

## 2. The Solution
We successfully integrated RTK natively into Aura Code's command execution layers by explicitly prefixing `rtk` to the shell commands.

**Files patched:**
1. `src/tools/telegram-bot.ts`
   - Modified `execShell` to automatically prepend `rtk ` to any executed command.
2. `src/tools/tools.ts`
   - Modified `runShell` to automatically prepend `rtk ` to raw bash commands.
   - Modified `gitStatus` to invoke `rtk git status --short`, `rtk git log`, and `rtk git branch`.
   - Modified `gitDiff` to explicitly run `rtk git diff`.

## 3. The Results
To verify the fix, we ran the exact same 3 complex tasks (Uncommitted Changes Review, TypeScript Compiler API Audit, and Changelog Web Page Generation) across four consecutive sessions:

| Run | Optimization Level | Input Tokens | Turns | Tool Calls |
|---|---|---|---|---|
| **Run 1** | No RTK (Raw Node Exec) | 1,286,806 | 40 | 60 |
| **Run 2** | `telegram-bot.ts` Patched | 946,293 | 39 | 70 |
| **Run 3** | `tools.ts` Patched | 397,519 | 16 | 28 |
| **Run 4** | Fully Optimized & Stable | **253,039** | **13** | **23** |

### Key Takeaways:
- **Token Reduction:** Achieved an **80.3% decrease** in total token consumption (from 1.28M to 253K).
- **Turn Efficiency:** The AI required **67.5% fewer turns** (from 40 down to 13) to complete the exact same workload. By feeding the AI clean, compressed summaries instead of raw terminal noise, the model avoids confusion and completes tasks significantly faster.
- **Cost:** The system is now heavily optimized for high-volume coding tasks with minimal API waste.

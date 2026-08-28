import * as path from 'path';
import * as fs from 'fs';
import type { LLMProvider, HistoryMessage, ToolCall, ToolResult } from '../providers/types.js';
import { selectTools, selectToolsWithEviction, executeTool } from '../tools/index.js';
import { PermissionSystem } from '../safety/permissions.js';
import { confirm } from '../safety/permissions.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';
import { sessionStore, type TurnUsage } from './session-store.js';
export type { TurnUsage };
import { registerSpawner, clearSpawner, makeDefaultSpawner } from './spawner.js';
import type { VerificationConfig } from '../verify/types.js';
import { getLoopProfile, detectStall, type LoopProfile, type StallKind } from './loop-profile.js';
import { describeBudgetStop, type BudgetStop } from './session-budget.js';
import { createCheckpoint, pruneCheckpoints } from '../checkpoints/engine.js';
import { DEFAULTS } from '../config/defaults.js';
import { MUTATING_TOOLS, ExecutiveQueue } from './executive-queue.js';
import { compactHistory, estimateContextTokens, getRecapGeneration, ROLLOVER_AT_GENERATION } from './compactor.js';
import { maybeRollover } from './generational-flush.js';
import { compactHistoryTiered, isTieredStrategyEnabled } from './tiered-context.js';
import { elideToolCallArgs, elideGoogleParts, pruneToolResultImages } from './tool-elision.js';
import { detectFrustration } from './affect.js';
import { createRepetitionGuard, describeRepetition, type Repetition } from './repetition-guard.js';
import { looksPromissory, MAX_PROMISE_NUDGES, PROMISE_CORRECTION } from './promise-guard.js';
import { ContextHealthTracker } from '../cli/context-health.js';
import { formatSteering, type SteeringInbox } from './steering.js';

/** How many times one task may have its reply cut off for collapsing into
 *  repetition before the run gives up on the model. Two, because the first
 *  correction usually lands and a third attempt is just paying for the same
 *  failure again. */
const MAX_REPETITION_RETRIES = 2;

/** Sent after a collapsed reply is cut off. Names the failure, then aims the
 *  model at the tool call it was narrating instead of making. */
const REPETITION_CORRECTION =
  'Your previous reply collapsed: it repeated the same phrase over and over until it was cut off. ' +
  'Do not describe or narrate what you are about to write. Make the tool call directly — ' +
  'call write_file once with the complete file content. If the file is genuinely too large for one ' +
  'call, write a first section with write_file and append the rest with follow-up edit_file calls.';

/** How many times a stalled run may be nudged to change approach before it
 *  gives up. Three, because a stall is usually one wrong idea the model keeps
 *  re-deriving, and naming it back is often enough to break it — but a model
 *  that ignores three explicit corrections is not going to obey a fourth. */
const MAX_STALL_CORRECTIONS = 3;

/** How many times the per-invocation turn ceiling may be extended before it
 *  becomes hard again. Twenty windows of the default 50 is 1,000 turns — far
 *  past any real task, but finite, which matters: AURA_SESSION_BUDGET=0 is
 *  documented as "no ceiling", so a budget alone is not proof the run can end.
 *  Without this, disabling the token ceiling turns an unproductive run into a
 *  genuinely infinite loop — the exact runaway the turn cap exists to stop. */
const MAX_TURN_EXTENSIONS = 20;

/** Sent when the stall detector fires. Names the loop concretely, then demands
 *  a different action rather than a retry of the same one. */
function stallCorrection(kind: StallKind, threshold: number): string {
  const what = kind === 'repeat'
    ? `You have now made the identical tool call ${threshold} times in a row.`
    : `You are alternating between the same two tool calls and have done so ${threshold} times.`;
  return `${what} Repeating it again will return the same result and make no progress. ` +
    'Stop and change approach: state in one sentence why the previous attempt did not work, ' +
    'then take a DIFFERENT action — inspect something you have not read yet, try another file or ' +
    'another tool, or if the task is already complete, say so and stop calling tools.';
}

/**
 * Provider errors can carry entire HTML error pages (e.g. a 404 from a
 * misconfigured endpoint). Dumping those into the terminal floods the TUI
 * with kilobytes of markup — keep the status line, drop the page body.
 */
export function formatProviderError(e: unknown): string {
  let msg = String(e).replace(/\s+/g, ' ').trim();
  const htmlIdx = msg.search(/<!DOCTYPE|<html[\s>]/i);
  if (htmlIdx !== -1) msg = msg.slice(0, htmlIdx).trim() + ' [HTML error page omitted]';
  return msg.length > 400 ? msg.slice(0, 400) + '…' : msg;
}

export interface LoopOptions {
  provider: LLMProvider;
  task: string;
  context: ProjectContext;
  permissions: PermissionSystem;
  display: Display;
  maxTurns?: number;
  /** Optional model id for token pricing — falls back to provider.model */
  pricingModel?: string;
  /** Path to a session file to persist history to; undefined = ephemeral */
  sessionPath?: string;
  /** Pre-existing conversation history to resume from (e.g. loaded session). */
  initialHistory?: HistoryMessage[];
  /** Base64 data URIs attached to the initial user message (multimodal input). */
  images?: string[];
  /** Base config passed to spawned sub-agents. If undefined, spawn_task returns an error. */
  spawnConfig?: { apiKey?: string; baseUrl?: string };
  /** Disables subagent tool entirely (e.g. for tests) */
  disableSpawn?: boolean;
  /** Internal: skip post-task verification (used by runWithVerification wrapper). */
  verify?: boolean;
  /** Shadow-git checkpoints before mutating tool calls (default: true; no-op outside a git repo). */
  checkpoints?: boolean;
  /** Plugin hooks fired around tool execution (PreToolUse can block). */
  hooks?: import('../plugins/types.js').HookEntry[];
  /** Optional abort signal — when aborted the loop stops after the current tool turn. */
  abortSignal?: AbortSignal;
  /** Suppresses the knowledge-gap pass that would otherwise run when this
   *  loop is about to give up. Set on the research sub-run and on the resumed
   *  run so the recovery is depth-1 — see agent/learning.ts. */
  noGapPass?: boolean;
  /** Mid-run steering: messages the user typed while this loop was working.
   *  Drained at each turn boundary and appended to history as a user turn, so
   *  a mid-run correction lands without cancelling the run. See steering.ts. */
  steering?: SteeringInbox;
  /** Confirmation prompt override for needs-confirm tool calls. Defaults to the
   *  terminal readline confirm — embedded callers (alternator, bots) supply
   *  their own so confirmation isn't silently impossible off-terminal. */
  confirmFn?: (message: string) => Promise<boolean>;
  /** Optional shared context-health tracker (e.g. the REPL's). When omitted the
   *  loop creates an internal one. Passing it in lets a /context command read
   *  the accumulated compaction history and per-turn snapshots. */
  healthTracker?: import('../cli/context-health.js').ContextHealthTracker;
  /** Internal: skip pre-planning inspector phase to avoid recursive spawning */
  skipInspector?: boolean;
  /** Replaces the full built system prompt (e.g. minimal prompt for small
   *  local models with tiny context windows). When set, buildSystemPrompt
   *  is not called at all. */
  systemPromptOverride?: string;
  /** When set, only tool definitions with these names are sent to the
   *  provider. Cuts context cost for small local models; execution-side
   *  blocking is still the PermissionSystem's job. */
  allowedTools?: string[];
  /** Conditional-tool eviction (small local models only). When enabled, a
   *  triggered conditional tool that goes uncalled for `evictAfterTurns`
   *  turns is dropped from the schema block instead of staying sticky.
   *  Defaults ON for the Archimedes (Ollama) provider, OFF everywhere else —
   *  cloud providers keep sticky selectTools() to protect the Anthropic
   *  prompt-cache prefix. */
  toolEviction?: { enabled: boolean; evictAfterTurns?: number };
  /** Primary-argument repetition limit for small local models (Archimedes).
   *  When set, the loop breaks early if any (tool_name, primary_arg) pair is
   *  called this many times — signals a stuck loop that won't self-correct.
   *  Only the primary argument is tracked (path for file tools, pattern for
   *  search_code) so reading different line ranges of the same file still
   *  counts as the same repeated call. Undefined = disabled (default). */
  maxRepetitionsPerTool?: number;
  /** Cumulative turn/token guard shared across every runAgentLoop call in one
   *  conversation. `maxTurns` above only bounds a single invocation; a
   *  multi-segment coder conversation resets that counter on each user
   *  message while history (and cost) carries forward. See session-budget.ts. */
  budget?: import('./session-budget.js').SessionBudget;
  /** Maximum chars kept from a single tool result before it enters history
   *  (non-error results only — errors keep a higher ceiling for diagnostics).
   *  Default: 4,000. Set lower (e.g. 1,500) for Archimedes Q&A sessions to
   *  reduce history noise from large ripgrep / file outputs. */
  toolResultMaxChars?: number;
}

export interface LoopResult {
  success: boolean;
  summary: string;
  turns: number;
  toolCallCount: number;
  usage: TokenUsage;
  costUsd: number;
  /** Full conversation history after the loop (including prior turns if resumed). */
  history: HistoryMessage[];
  /** Every tool call made during this loop run — used by the verify layer. */
  toolCallLog: Array<{ name: string; input: Record<string, unknown> }>;
  /** Real per-API-call usage as reported by the provider, one entry per
   *  completed call. Optional so older consumers/paths (MoA, Archimedes) that
   *  don't collect it stay type-compatible. */
  turnUsage?: TurnUsage[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

/**
 * Read-only, deterministic tools whose result depends solely on workspace
 * state. Safe to serve from the per-run cache until something mutates.
 * Deliberately excludes non-deterministic tools (web_fetch, web_search,
 * http_request, browser) and anything with side effects.
 */
const CACHEABLE_READ_TOOLS = new Set([
  'read_file', 'list_dir', 'git_diff', 'git_status', 'search_code', 'search_semantic',
]);

/** Stable cache key for a tool call — key order must not affect identity. */
function callSignature(name: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return `${name}(${keys.map(k => `${k}=${JSON.stringify(input[k])}`).join(',')})`;
}

/**
 * Normalize a tool-input path for cache scoping. Returns undefined when the
 * path can't be reasoned about safely ('..', absolute) — callers treat that
 * as workspace-wide, i.e. invalidated by any mutation.
 */
function normalizeCachePath(p: string): string | undefined {
  if (p.includes('..') || p.startsWith('/')) return undefined;
  const norm = p.replace(/^\.\//, '').replace(/\/+$/, '');
  return norm === '.' ? '' : norm;
}

/** Two normalized paths overlap when one is a prefix of the other; '' (root)
 *  overlaps everything. */
function cachePathsOverlap(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * Canonical identity of a path: fully resolves symlinks when the file exists,
 * so a cached read via one alias is invalidated by a write via another
 * (symlink, case-variant filesystem, 'a/../b' forms). For not-yet-existing
 * files (a fresh write_file target) it resolves the parent directory and
 * appends the basename. Returns undefined only when even the parent can't be
 * resolved — callers then rely on the string-overlap check alone.
 */
function canonicalPath(root: string, p: string): string | undefined {
  try {
    return fs.realpathSync(path.resolve(root, p));
  } catch {
    try {
      const abs = path.resolve(root, p);
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return undefined;
    }
  }
}

/**
 * First/last line numbers actually present in a read_file result text,
 * parsed from the tool's `N: ` line prefixes. This reflects what is REALLY
 * in context — a char-truncated result covers fewer lines than requested,
 * and the parser must not overclaim. When the text carries a truncation
 * marker, the last numbered line is only partially in context and is
 * excluded from the span (underclaiming is safe; overclaiming would elide a
 * read the model can't actually satisfy from context).
 */
function coveredLineSpan(text: string): { start: number; end: number } | undefined {
  // Head+tail whole-file reads interleave line 1 and line N — the span
  // between them is NOT in context. Guarded by the caller too, but the
  // parser must never be the last line of defense.
  if (text.includes('lines omitted')) return undefined;
  const matches: RegExpMatchArray[] = [];
  for (const m of text.matchAll(/^(\d+):/gm)) matches.push(m);
  if (matches.length === 0) return undefined;
  // loop.ts truncation markers: '[truncated — N chars omitted]' and
  // '[result truncated: …]'.
  if (/truncated/.test(text)) matches.pop();
  if (matches.length === 0) return undefined;
  return {
    start: parseInt(matches[0][1], 10),
    end: parseInt(matches[matches.length - 1][1], 10),
  };
}

/**
 * Overlapping-range elision for read_file: agents re-read growing ranges of
 * the same file (1–200, then 1–400, …). If the requested range is fully
 * inside a range whose result is still verbatim in history and the workspace
 * is unchanged (guaranteed by readCoverage being invalidated on mutation),
 * return a short note instead of re-reading and re-sending the overlap.
 * Conservative by design: whole-file requests, head+tail-truncated results,
 * and ranges not provably covered all fall through to a real read.
 */
function tryElideSubsetRead(
  call: ToolCall,
  coveredText: string | undefined,
  history: HistoryMessage[],
): string | undefined {
  if (!coveredText || coveredText.includes('lines omitted')) return undefined;
  const input = call.input as { path?: string; start_line?: number; end_line?: number };
  const start = input.start_line ?? 1;
  const end = input.end_line;
  // No end bound = whole-file request; we can't prove coverage without
  // knowing the file's total line count.
  if (end === undefined) return undefined;
  const covered = coveredLineSpan(coveredText);
  if (!covered) return undefined;
  if (start < covered.start || end > covered.end) return undefined;
  const stillInContext = history.some(m =>
    m.role === 'tool_result' && m.results.some(r => r.content === coveredText));
  if (!stillInContext) return undefined;
  return `[lines ${start}–${end} of ${input.path} are within the earlier read (lines ${covered.start}–${covered.end}), already in context, and the workspace is unchanged. Result omitted — reuse the copy already in context.]`;
}

const PRICING_USD_PER_MTOK: Record<string, { in: number; out: number; cachedIn?: number }> = {
  'claude-opus-4-5-20251001':   { in: 15,  out: 75  },
  'claude-sonnet-4-5-20251001': { in: 3,   out: 15  },
  'claude-haiku-4-5-20251001':  { in: 0.8, out: 4   },
  'gpt-4o':                     { in: 2.5, out: 10  },
  'gpt-4o-mini':                { in: 0.15,out: 0.6 },
  'gemini-pro-latest':          { in: 1.25,out: 10  },
  'gemini-3.6-flash':           { in: 0.075,out: 0.3},
  'gemini-3.5-flash':           { in: 0.075,out: 0.3},
  'gemini-3.5-flash-lite':      { in: 0.05,out: 0.2 },
  'gemini-3.1-flash-lite':      { in: 0.05,out: 0.2 },
  'grok-beta':                  { in: 5,   out: 15  },
  // Published rates, docs.z.ai/guides/overview/pricing (checked 2026-07-26).
  // 5.1/5.2 were previously carried at the GLM-5 rate on the assumption they
  // matched; they don't — both input and output were understated.
  'glm-5.2':                    { in: 1.4, out: 4.4, cachedIn: 0.26 },
  'glm-5.1':                    { in: 1.4, out: 4.4, cachedIn: 0.26 },
  'glm-5':                      { in: 1,   out: 3.2, cachedIn: 0.2  },
  'glm-5-turbo':                { in: 1.2, out: 4,   cachedIn: 0.24 },
  'mimo-v2.5-pro':              { in: 1,   out: 4   },
  'mimo-v2.5':                  { in: 0.5, out: 2   },
  'mimo-v2-flash':              { in: 0.1, out: 0.4 },
  // DeepSeek V4 — cache hits billed at 1/10th of standard input rate.
  'deepseek-v4-flash':          { in: 0.14, out: 0.28, cachedIn: 0.014 },
  'deepseek-v4-pro':            { in: 0.435, out: 0.87, cachedIn: 0.0435 },
};

export function costFor(model: string, input: number, output: number, cachedTokens?: number): number {
  const p = PRICING_USD_PER_MTOK[model] ?? PRICING_USD_PER_MTOK[Object.keys(PRICING_USD_PER_MTOK).find(k => model.includes(k.split('-')[1] ?? '') && k.startsWith(model.split('-')[0] ?? '')) ?? ''] ?? { in: 0, out: 0 };
  const cached = Math.min(cachedTokens ?? 0, input);
  const billable = input - cached;
  const cachedRate = p.cachedIn ?? p.in / 10;
  return (billable / 1_000_000) * p.in + (cached / 1_000_000) * cachedRate + (output / 1_000_000) * p.out;
}

/**
 * Scan `calls` from the current turn, update `counts`, and return a
 * human-readable reason string if any (tool_name, primary_arg) pair has now
 * been called `threshold` or more times, or null if no loop detected.
 *
 * Only the primary argument is inspected — `path` for read_file / list_dir /
 * search_semantic, `pattern` for search_code. Secondary args (start_line,
 * end_line, …) are intentionally ignored: reading different line ranges of
 * the same file is the same stuck behaviour, not progress.
 * Pure except for updating `counts` in place.
 */
function checkPrimaryArgRepetition(
  counts: Map<string, number>,
  calls: ToolCall[],
  threshold: number,
): string | null {
  for (const call of calls) {
    const input = call.input as Record<string, unknown>;
    const primaryArg = String(input.path ?? input.pattern ?? input.query ?? '');
    const key = `${call.name}:${primaryArg}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n >= threshold) {
      return `repetition loop — ${call.name}('${primaryArg}') called ${n}x with no new information`;
    }
  }
  return null;
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const { provider, task, context, permissions, display } = opts;

  let finalTask = task;
  if (!opts.skipInspector && process.env.AURA_ENABLE_INSPECTOR === 'true') {
    const { runInspector } = await import('../orchestration/inspector.js');
    const report = await runInspector(task, context, display);
    finalTask = `${task}\n\n${report}`;
  }

  const profile = getLoopProfile(opts.maxTurns);
  const pricingModel = opts.pricingModel ?? provider.model;

  const system = opts.systemPromptOverride ?? buildSystemPrompt(context, provider.name, finalTask);
  const history: HistoryMessage[] = [
    ...(opts.initialHistory ?? []),
    { role: 'user', content: finalTask, ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}) },
  ];

  let turns = 0;
  let toolCallCount = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 };

  if (!opts.disableSpawn) {
    registerSpawner(makeDefaultSpawner(context, opts.spawnConfig ?? {}, display));
  }

  display.agentThinking();

  try {
    return await runLoopBody({ opts, provider, system, history, profile, pricingModel, display, permissions, turns, toolCallCount, usage });
  } finally {
    display.stopThinking?.();
    clearSpawner();
  }
}

interface BodyArgs {
  opts: LoopOptions;
  provider: LLMProvider;
  system: string;
  history: HistoryMessage[];
  profile: LoopProfile;
  pricingModel: string;
  display: Display;
  permissions: PermissionSystem;
  turns: number;
  toolCallCount: number;
  usage: TokenUsage;
}

async function runLoopBody(args: BodyArgs): Promise<LoopResult> {
  const { opts, provider, system, history, profile, pricingModel, display, permissions } = args;
  let { turns, toolCallCount, usage } = args;
  const toolCallLog: Array<{ name: string; input: Record<string, unknown> }> = [];
  const turnUsage: TurnUsage[] = [];
  // Bounded record of state-altering calls; its digest survives compaction so
  // the model never repeats a write/edit/command it already executed.
  const execQueue = new ExecutiveQueue();

  // Context health tracker: observational visibility into token pressure,
  // compaction ladder, and session cost. Never mutates history itself.
  // Use the caller-provided tracker (so /context can read it) or make one.
  const health = opts.healthTracker ?? new ContextHealthTracker(() => system, () => history, provider.model, pricingModel);
  health.updateSystem(system);

  // Stall detection: if the recent turns repeat the exact same tool call(s)
  // (or alternate between the same two), the agent is stuck rather than
  // progressing. Stopping early here saves turns/cost on a run that would
  // otherwise burn out to maxTurns without ever changing course.
  const turnSignatures: string[] = [];
  let stall: StallKind | null = null;

  // Flat ceiling — checked once per turn, no widening. See loop-profile.ts
  // for why this replaced the old shape-based ladder.
  const maxTurns = profile.maxTurns;

  // Mutable bag for per-loop state (empty-response retry counter, etc.).
  const loopState: Record<string, number> = {};

  // Redundant-read cache. Exploratory runs routinely re-read the same file or
  // re-list the same directory several turns apart, paying full I/O and a full
  // second copy of the content in context each time. Cached results are keyed
  // by exact call signature and dropped the moment anything mutates the
  // workspace, so a hit can never serve stale content. Each entry remembers
  // the path it came from so a write_file/edit_file only invalidates the
  // entries that path could have changed, instead of nuking the whole cache
  // and forcing re-reads (which then re-enter context — the exact waste this
  // cache exists to prevent). Entries without a resolvable path (git_status,
  // whole-root searches, .. paths) are treated as workspace-wide: any write
  // drops them, matching the old wholesale-clear semantics.
  const readCache = new Map<string, { text: string; path?: string }>();
  // Per-path record of the last successful read_file result, used to elide
  // *overlapping* range reads (see tryElideSubsetRead). Invalidated together
  // with readCache, so a record always describes the current workspace.
  const readCoverage = new Map<string, { text: string }>();

  // Sticky set of triggered conditional tools — survives history compaction.
  const includedTools = new Set<string>();

  // Tool eviction: Archimedes's call site (alternator.ts) is owned by another
  // track, so eviction defaults on by provider identity; the flag remains
  // the explicit override for other embedders. Cloud providers stay sticky.
  const evictionEnabled = opts.toolEviction?.enabled
    ?? provider.name === 'Archimedes (Ollama)';
  const evictAfterTurns = opts.toolEviction?.evictAfterTurns ?? 3;
  const lastUsedTurn = new Map<string, number>();
  const evictedTools = new Set<string>();

  // Optional allowlist filter — applied after selectTools so conditional
  // triggers still work, but nothing outside the allowlist is ever sent.
  const allowedToolNames = opts.allowedTools ? new Set(opts.allowedTools) : null;

  // Primary-arg repetition tracking — Archimedes early-exit only.
  // Null when the option is not set so there is zero overhead on normal runs.
  const primaryArgCounts = opts.maxRepetitionsPerTool !== undefined
    ? new Map<string, number>()
    : null;
  let primaryArgLoopReason: string | null = null;

  // Cumulative guard across the whole conversation. Checked alongside the
  // per-invocation cap below: on a single-segment run the two agree, but on a
  // multi-segment coder conversation only this one carries forward.
  let budgetStop: BudgetStop | null = null;

  // Per-invocation turn ceiling. Extended in place rather than enforced as a
  // hard stop when a SessionBudget is present: the cap exists to bound a
  // runaway, and SessionBudget already bounds one far more meaningfully (by
  // billed input tokens, cumulatively, across the whole conversation). Halting
  // a *productive* run at turn 50 to make the user type /continue does not save
  // anything — the next segment resends the same history — it just moves the
  // decision to a human who has no more information than the loop does.
  //
  // With no budget supplied (embedders that omit it) the ceiling stays hard,
  // because then nothing else is counting.
  let turnCeiling = maxTurns;
  let turnExtensions = 0;
  let stallCorrections = 0;

  while (true) {
    if (turns >= turnCeiling) {
      // Extension is justified only by something else actually counting. A
      // budget of Infinity/Infinity (AURA_SESSION_BUDGET=0, "no ceiling")
      // counts nothing, so it is no basis for lifting this ceiling — there the
      // cap stays hard, and it is the only thing standing between an
      // unproductive run and an unbounded one.
      const b = opts.budget;
      const bounded = b != null
        && (Number.isFinite(b.maxInputTokens) || Number.isFinite(b.maxTurns));
      if (!bounded || b.exhausted() !== null || turnExtensions >= MAX_TURN_EXTENSIONS) break;
      turnExtensions++;
      turnCeiling += maxTurns;
      display.warning(
        `Turn ${turns} — past the ${maxTurns}-turn window, continuing to ${turnCeiling} ` +
        `(session token budget still has room; extension ${turnExtensions}/${MAX_TURN_EXTENSIONS}).`,
      );
    }

    if (opts.budget) {
      budgetStop = opts.budget.exhausted();
      if (budgetStop) break;
    }

    // Abort check — user requested stop via :stop / Ctrl+C
    if (opts.abortSignal?.aborted) {
      display.warning('Task cancelled by user — stopping loop.');
      break;
    }

    // Mid-run steering. Drained here, at the one point in the turn where the
    // last tool_use block already has its result and history is a shape every
    // provider accepts. Appended before the compaction check below so a long
    // steered message counts toward the payload being measured.
    const steered = opts.steering?.drain() ?? [];
    if (steered.length > 0) {
      history.push({ role: 'user', content: formatSteering(steered) });
      display.steering?.(steered);
      await persist(opts.sessionPath, history);
    }

    turns++;
    opts.budget?.recordTurn();
    health.incrementTurn();

    // Compaction check runs pre-call: estimateContextTokens measures the
    // payload about to be sent (see its doc for why not per-turn usage sums).
    {
      const compactionExtras = {
        executiveDigest: execQueue.size > 0 ? execQueue.digest() : undefined,
        affectHint: detectFrustration(history) ?? undefined,
      };
      if (isTieredStrategyEnabled()) {
        // Tiered strategy (ANCHOR + FACT LOG + TAIL) — see tiered-context.ts.
        // No rollover step: the fact log stays lightweight bullets rather
        // than a growing prose recap, so it doesn't need the dream-store
        // flush the default strategy relies on to bound recap size.
        const estimated = estimateContextTokens(system, history);
        const { compacted, metrics } = await compactHistoryTiered(
          history, estimated, provider.model, opts.sessionPath, compactionExtras,
        );
        if (compacted && metrics) {
          health.recordCompaction(metrics.beforeTokens, metrics.afterTokens, metrics.compactionCount);
          display.compactionEvent?.({
            beforeTokens: metrics.beforeTokens, afterTokens: metrics.afterTokens,
            generation: metrics.compactionCount, threshold: metrics.beforeTokens,
          });
          logContextMetrics(opts.context.root, { ...metrics });
          await persist(opts.sessionPath, history);
        }
      } else
      // The ladder in compactHistory escalates its own trigger per recap
      // generation; once a recap has been recompacted ROLLOVER_AT_GENERATION
      // times, a further in-place pass would just be lossy recompaction —
      // flush it to the dream store instead (one LLM call) and start clean.
      if (getRecapGeneration(history) >= ROLLOVER_AT_GENERATION) {
        const beforeTokens = estimateContextTokens(system, history);
        const { flushed } = await maybeRollover(history, opts.context.root, provider, compactionExtras);
        if (flushed) {
          const afterTokens = estimateContextTokens(system, history);
          const generation = getRecapGeneration(history);
          health.recordCompaction(beforeTokens, afterTokens, generation);
          display.compactionEvent?.({ beforeTokens, afterTokens, generation, threshold: beforeTokens });
          logContextMetrics(opts.context.root, { strategy: 'default-rollover', beforeTokens, afterTokens, generation });
          await persist(opts.sessionPath, history);
        }
      } else {
        const estimated = estimateContextTokens(system, history);
        const compacted = compactHistory(history, estimated, provider.model, compactionExtras);
        if (compacted) {
          const afterTokens = estimateContextTokens(system, history);
          const generation = getRecapGeneration(history);
          health.recordCompaction(estimated, afterTokens, generation);
          display.compactionEvent?.({ beforeTokens: estimated, afterTokens, generation, threshold: estimated });
          logContextMetrics(opts.context.root, { strategy: 'default', beforeTokens: estimated, afterTokens, generation });
          await persist(opts.sessionPath, history);
        }
      }
    }

    // Predictive ceiling check — runs AFTER compaction, so it measures the
    // payload we are actually about to send rather than the pre-compaction
    // one. exhausted() above only notices an overshoot once the offending
    // call has already been billed; this stops before it. Costs one
    // tokenizer pass over the same text compaction just measured.
    if (opts.budget) {
      const projected = opts.budget.wouldExceed(estimateContextTokens(system, history));
      if (projected) {
        budgetStop = projected;
        turns--;           // this turn never happened — no call was made
        opts.budget.unrecordTurn();
        break;
      }
    }

    display.contextBar?.(health.snapshot(usage.inputTokens, usage.outputTokens));

    let responseText = '';
    const responseToolCalls: ToolCall[] = [];
    let finalResponse: { stopReason: 'done' | 'tools' | 'limit' } | null = null;
    // Watches for a reply that collapses into repeating one phrase. Left to run
    // to the output cap, that costs a full max_tokens of output and returns
    // nothing usable — see repetition-guard.ts.
    const repGuard = createRepetitionGuard();
    let repetition: Repetition | null = null;

    try {
      let tools = evictionEnabled
        ? selectToolsWithEviction(opts.task, history, includedTools, lastUsedTurn, turns, evictAfterTurns, evictedTools)
        : selectTools(opts.task, history, includedTools);
      if (allowedToolNames) tools = tools.filter(t => allowedToolNames.has(t.name));
      const stream = provider.stream(system, history, tools);
      streamLoop: for await (const chunk of stream) {
        switch (chunk.type) {
          case 'text':
            display.streamText(chunk.text);
            responseText += chunk.text;
            // Breaking out returns the generator, which aborts the request, so
            // the provider stops generating (and billing) the rest of the loop.
            repetition = repGuard.push(chunk.text);
            if (repetition) break streamLoop;
            break;
          case 'tool_start':
            display.toolStart(chunk.name, chunk.id);
            break;
          case 'tool_input':
            break;
          case 'tool_end':
            responseToolCalls.push(chunk.call);
            break;
          case 'done':
            finalResponse = chunk.response;
            if (chunk.response.toolCalls.length > 0 && responseToolCalls.length === 0) {
              responseToolCalls.push(...chunk.response.toolCalls);
            }
            const u = (chunk.response as { usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } }).usage;
            if (u) {
              const inT = u.inputTokens ?? 0;
              const outT = u.outputTokens ?? 0;
              const cachedT = u.cachedTokens ?? 0;
              usage.inputTokens += inT;
              usage.outputTokens += outT;
              usage.totalTokens += inT + outT;
              usage.cachedTokens += cachedT;
              // Net of cache hits, not raw prompt size — this is the ceiling
              // that actually tracks cost across conversation segments.
              opts.budget?.recordCall(inT, cachedT);
              const at = new Date().toISOString();
              const turnCost = costFor(pricingModel, inT, outT, cachedT);
              turnUsage.push({
                turn: turns,
                at,
                inputTokens: inT,
                outputTokens: outT,
                cachedTokens: cachedT,
                cacheCreationTokens: u.cacheCreationTokens ?? 0,
                costUsd: turnCost,
              });
              logTokenUsage(opts.context.root, {
                turn: turns, ts: at, model: provider.model,
                input: inT, output: outT,
                cacheHit: cachedT, cacheWrite: u.cacheCreationTokens ?? 0,
                hitRatio: inT > 0 ? cachedT / inT : 0,
                costUsd: turnCost,
                ...(opts.sessionPath ? { sessionId: path.basename(opts.sessionPath, '.json') } : {}),
              });
            }
            break;
        }
      }
    } catch (e) {
      const errMsg = formatProviderError(e);
      display.error(`Provider error: ${errMsg}`);
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary: `Provider error on turn ${turns}: ${errMsg}`,
        turns, toolCallCount, usage, history, toolCallLog, turnUsage,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    if (responseText) display.streamEnd();

    // The reply collapsed into a repeating phrase and was cut off. Two things
    // matter here: the degenerate text must not reach history (a model shown its
    // own loop continues it), and the turn is worth one more attempt with the
    // collapse named explicitly — the task itself is usually still doable.
    if (repetition) {
      loopState._repetitionRetries = ((loopState._repetitionRetries as number) ?? 0) + 1;
      const attempts = loopState._repetitionRetries as number;
      display.warning(
        `Reply collapsed — ${describeRepetition(repetition)}. Cut it off` +
        (attempts <= MAX_REPETITION_RETRIES ? ' and retrying with a correction…' : '.'),
      );
      if (attempts <= MAX_REPETITION_RETRIES) {
        // A short, honest stand-in keeps role alternation valid for providers
        // that require it, without feeding the loop back to the model. Only the
        // text from before the collapse is kept — a model shown even a handful
        // of copies of its own loop tends to carry on with it.
        const collapseAt = responseText.indexOf(repetition.unit);
        const preamble = (collapseAt > 0 ? responseText.slice(0, collapseAt) : '').trim().slice(0, 200);
        history.push({
          role: 'assistant',
          content: `${preamble ? `${preamble}\n` : ''}[reply cut off: ${describeRepetition(repetition)}]`,
        });
        history.push({ role: 'user', content: REPETITION_CORRECTION });
        display.agentThinking();
        continue;
      }
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary:
          `The model's reply collapsed into repetition ${attempts}× in a row ` +
          `(${describeRepetition(repetition)}). This is a model failure, not a task failure — ` +
          `try a narrower step, or a stronger model with --model / :model.`,
        turns, toolCallCount, usage, history, toolCallLog, turnUsage,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    // Guard: an empty response with no tools and stop reason "done"
    // usually means the provider returned a silent error / rate-limit /
    // content filter. Retry up to 3 times before accepting it as "done"
    // so sessions don't silently die with no output.
    const noProgress = !responseText && responseToolCalls.length === 0;
    if (finalResponse?.stopReason === 'done' && noProgress) {
      if (!('_emptyRetries' in loopState)) loopState._emptyRetries = 0;
      loopState._emptyRetries++;
      if (loopState._emptyRetries <= 3) {
        display.warning(
          `Empty response from provider (attempt ${loopState._emptyRetries}/3) — retrying…`,
        );
        display.agentThinking();
        continue;
      }
      // Exhausted retries — provider can't produce output
      history.push({ role: 'assistant', content: '' });
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary: 'Provider returned empty response after 4 attempts — likely rate-limited or filtered',
        turns, toolCallCount, usage, history, toolCallLog, turnUsage,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    if (finalResponse?.stopReason === 'done') {
      // A run that called nothing and signed off by announcing the work is not
      // finished — it is the "1 turn · 0 tool call" failure, where the loop
      // reports success for a promise. Push back instead of returning, but only
      // when the whole run touched no tools: a reply with prose after real work
      // is a summary, which is exactly what we want here.
      if (toolCallCount === 0 && looksPromissory(responseText)
          && (loopState._promiseNudges ?? 0) < MAX_PROMISE_NUDGES) {
        loopState._promiseNudges = (loopState._promiseNudges ?? 0) + 1;
        display.warning(
          `Model described the work instead of doing it (no tool calls) — ` +
          `telling it to act (nudge ${loopState._promiseNudges}/${MAX_PROMISE_NUDGES}).`,
        );
        history.push({ role: 'assistant', content: responseText });
        history.push({ role: 'user', content: PROMISE_CORRECTION });
        display.agentThinking();
        continue;
      }

      history.push({ role: 'assistant', content: responseText });
      await persist(opts.sessionPath, history);
      return {
        // Still not a success if it never acted: reporting "Done" for a promise
        // is what sent the user back to retype the task.
        success: !(toolCallCount === 0 && looksPromissory(responseText)),
        summary: responseText,
        turns, toolCallCount, usage, history, toolCallLog, turnUsage,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    if (finalResponse?.stopReason === 'limit') {
      display.warning('Hit token limit — stopping loop');
      break;
    }

    const assistantMsg: HistoryMessage = {
      role: 'assistant',
      content: responseText,
      // History copy only: large string arguments (write_file.content,
      // edit_file.replace, …) are elided to size stubs so the payload isn't
      // re-sent on every later turn. The live call above kept full args for
      // display, toolCallLog, execQueue, and the read cache.
      toolCalls: responseToolCalls.map(elideToolCallArgs),
    };
    if ((finalResponse as any)?.googleParts) {
      (assistantMsg as any).googleParts = elideGoogleParts((finalResponse as any).googleParts);
    }
    history.push(assistantMsg);

    // Record this turn's tool-call signature before executing, so a
    // stall is detected even if every call in the streak errors out.
    if (responseToolCalls.length > 0) {
      const signature = JSON.stringify(
        responseToolCalls.map((c) => ({ name: c.name, input: c.input })),
      );
      turnSignatures.push(signature);
      stall = detectStall(turnSignatures, profile.stallThreshold);
    }

    // Primary-arg repetition check — Archimedes early-exit (maxRepetitionsPerTool).
    if (primaryArgCounts && responseToolCalls.length > 0) {
      primaryArgLoopReason = checkPrimaryArgRepetition(
        primaryArgCounts, responseToolCalls, opts.maxRepetitionsPerTool!,
      );
    }

    const toolResults: ToolResult[] = [];
    // One checkpoint per turn, taken lazily before the first mutating call —
    // a turn's writes form one burst, and the engine dedupes identical trees.
    let checkpointedThisTurn = false;

    for (const call of responseToolCalls) {
      toolCallCount++;
      // Any attempted call counts as "used" for eviction — the model
      // demonstrably wants the tool even if the call is blocked or errors.
      lastUsedTurn.set(call.name, turns);
      display.toolCall(call.name, call.input);

      let result: string;
      let isError = false;
      /** Images the tool produced, kept out of `result` so the truncation and
       *  caching below never see them. */
      let resultImages: string[] | undefined;
      try {
        const perm = permissions.check(call.name, call.input);
        if (!perm.allowed) {
          display.toolBlocked(call.name, perm.reason ?? 'not permitted');
          toolResults.push({ id: call.id, name: call.name, content: `Blocked: ${perm.reason}`, isError: true });
          continue;
        }

        if (perm.needsConfirm) {
          const desc = formatCallForConfirmation(call);
          const approved = await (opts.confirmFn ?? confirm)(
            `Allow: ${desc}?`,
            { toolName: call.name, input: call.input },
          );
          if (!approved) {
            display.toolBlocked(call.name, 'denied by user');
            toolResults.push({ id: call.id, name: call.name, content: 'User denied this action.', isError: true });
            continue;
          }
          // Remember it, so writing the same file across several turns asks
          // once. Without this the approval is forgotten immediately and the
          // prompt repeats until the user stops reading it.
          if (perm.approvalKey) opts.permissions.approveForSession(perm.approvalKey);
        }

        if (opts.checkpoints !== false && !checkpointedThisTurn && MUTATING_TOOLS.has(call.name)) {
          checkpointedThisTurn = true;
          try {
            const cp = await createCheckpoint(opts.context.root, `turn ${turns}: ${opts.task}`);
            if (cp) await pruneCheckpoints(opts.context.root, DEFAULTS.maxCheckpoints);
          } catch { /* checkpointing must never block the tool call */ }
        }

        if (opts.hooks && opts.hooks.length > 0) {
          const { runHooks } = await import('../plugins/hooks.js');
          const pre = await runHooks('PreToolUse', call.name, call.input, opts.hooks, opts.context.root);
          if (pre.block) {
            const why = pre.messages.join('; ') || 'blocked by plugin hook';
            display.toolBlocked(call.name, why);
            toolResults.push({ id: call.id, name: call.name, content: `Blocked by plugin hook: ${why}`, isError: true });
            continue;
          }
        }

        // Any mutation invalidates cached reads: a shell command can change
        // arbitrary paths (full clear), but write_file/edit_file only touch a
        // known path — invalidating just the entries that path could have
        // changed keeps unrelated cached reads warm, so the agent isn't
        // forced to re-read (and re-pay for) files it already has in context.
        // Cleared before execution so a mutation that throws still drops the
        // cache rather than leaving it falsely warm. Paths we can't scope
        // safely ('..', absolute) fall back to the full clear.
        if (MUTATING_TOOLS.has(call.name) || call.name === 'run_tests') {
          const norm = typeof call.input.path === 'string'
            ? normalizeCachePath(call.input.path)
            : undefined;
          if ((call.name === 'write_file' || call.name === 'edit_file') && norm !== undefined) {
            // Alias safety net: a write via a symlink/case/`..` alias of a
            // cached path must still invalidate it. Realpath comparison is
            // per-entry I/O, so it only runs for entries the cheap string
            // overlap did NOT already match.
            const canonTarget = canonicalPath(opts.context.root, norm);
            for (const [k, v] of readCache) {
              if (v.path === undefined || cachePathsOverlap(v.path, norm)) {
                readCache.delete(k);
                continue;
              }
              if (canonTarget !== undefined) {
                const canonEntry = canonicalPath(opts.context.root, v.path);
                if (canonEntry !== undefined && canonEntry === canonTarget) readCache.delete(k);
              }
            }
            for (const k of readCoverage.keys()) {
              if (k === undefined || cachePathsOverlap(k, norm)) readCoverage.delete(k);
            }
          } else {
            readCache.clear();
            readCoverage.clear();
          }
        }

        const sig = callSignature(call.name, call.input);
        const cacheable = CACHEABLE_READ_TOOLS.has(call.name);
        const cached = cacheable ? readCache.get(sig) : undefined;
        const cachedText = cached?.text;

        if (cachedText !== undefined) {
          // The content is only elided if it is still verbatim in the live
          // history — if compaction has since dropped it, the model genuinely
          // no longer has it and must get the full result back.
          const stillInContext = history.some(m =>
            m.role === 'tool_result' && m.results.some(r => r.content === cachedText));
          result = stillInContext
            ? `[identical to the earlier ${sig} call this session; workspace unchanged since. Result omitted — reuse the copy already in context.]`
            : cachedText;
          display.toolResult(call.name, result, 0);
        } else {
          // Overlapping-range elision: a read whose range is a subset of an
          // earlier read still in context returns a note instead of re-reading
          // (see tryElideSubsetRead). Only for read_file with a scoped path.
          const pathArg = call.input.path;
          const normPath = typeof pathArg === 'string' ? normalizeCachePath(pathArg) : undefined;
          const subsetNote = (call.name === 'read_file' && normPath !== undefined)
            ? tryElideSubsetRead(call, readCoverage.get(normPath)?.text, history)
            : undefined;
          if (subsetNote !== undefined) {
            result = subsetNote;
            display.toolResult(call.name, result, 0);
          } else {
            const startMs = Date.now();
            const out = await executeTool(call.name, call.input, opts.context.root);
            // Split the visual part off immediately: everything downstream —
            // truncation, the read cache, isError, elision — reasons about the
            // text, and images must not be truncated or cached as text.
            if (typeof out === 'string') {
              result = out;
            } else {
              result = out.text;
              if (out.images?.length) resultImages = out.images;
            }
            const elapsed = Date.now() - startMs;
            display.toolResult(call.name, result, elapsed);
          }
        }
        // Elision notes (exact-hit and subset) are never cached: they are
        // history-dependent by construction (the note only makes sense while
        // the original content is still in context), and caching a note
        // would overwrite the real coverage record readCoverage relies on.
        const isElisionNote = result.startsWith('[identical to the earlier') || result.startsWith('[lines ');
        // Proactive truncation: align with the compactor's MAX_RESULT_CHARS
        // (4K chars ~1K tokens). Oversized results pollute context between
        // compaction cycles — truncate early so every API call carries less
        // dead weight. Errors get a higher ceiling so diagnostics survive.
        // toolResultMaxChars narrows the normal limit for small-model sessions
        // (e.g. Archimedes at 1,500 chars) without affecting error diagnostics.
        const normalLimit = opts.toolResultMaxChars ?? 4_000;
        const RESULT_TRUNCATE_AT = result.startsWith('Error:') || result.startsWith('Tool error') ? 8_000 : normalLimit;
        if (result.length > RESULT_TRUNCATE_AT) {
          result = result.slice(0, RESULT_TRUNCATE_AT)
            + `\n[truncated — ${(result.length - RESULT_TRUNCATE_AT).toLocaleString()} chars omitted]`;
        }
        isError = result.startsWith('Error:') || result.startsWith('Tool error');
        // Cache the post-truncation text — that is exactly what lands in
        // history, so a later hit can compare against it verbatim. Errors are
        // never cached: they are frequently transient and re-reading is cheap.
        // Elision notes are never cached either (see isElisionNote above).
        // read_file results also feed the range-coverage record used by
        // subset-range elision (same staleness discipline: cleared on any
        // mutation of that path).
        if (cached === undefined && cacheable && !isError && !isElisionNote) {
          const normPath = typeof call.input.path === 'string'
            ? normalizeCachePath(call.input.path)
            : undefined;
          readCache.set(sig, { text: result, path: normPath });
          if (call.name === 'read_file' && normPath !== undefined) {
            readCoverage.set(normPath, { text: result });
          }
        }
        toolCallLog.push({ name: call.name, input: call.input });
        if (!isError) execQueue.push(call.name, call.input, turns);

        if (opts.hooks && opts.hooks.length > 0) {
          const { runHooks } = await import('../plugins/hooks.js');
          await runHooks('PostToolUse', call.name, call.input, opts.hooks, opts.context.root, result);
        }
      } catch (e) {
        result = `Tool error (${call.name}): ${String(e)}`;
        isError = true;
        display.error(result);
      }
      // Safety net: prevent any single tool result from consuming excessive
      // context. 8K chars (~2K tokens) is enough for any meaningful output;
      // larger results mean the agent should narrow its query or use ranges.
      const MAX_TOOL_RESULT_CHARS = 8_000;
      if (result.length > MAX_TOOL_RESULT_CHARS) {
        result = result.slice(0, MAX_TOOL_RESULT_CHARS)
          + `\n[result truncated: ${result.length.toLocaleString()} chars total — narrow the query or read the file in ranges]`;
      }
      toolResults.push({
        id: call.id, name: call.name, content: result, isError,
        ...(resultImages?.length ? { images: resultImages } : {}),
      });
    }

    health.incrementToolCalls(responseToolCalls.length);

    history.push({ role: 'tool_result', results: toolResults });
    // Keep only the newest screenshots: every image in history is re-sent on
    // every later turn, so an unpruned run pays for all of them, repeatedly.
    pruneToolResultImages(history);

    if (stall) {
      const what = stall === 'repeat'
        ? `Repeated identical tool call ${profile.stallThreshold}x in a row`
        : `Alternating between the same two tool calls ${profile.stallThreshold}x`;
      if (stallCorrections < MAX_STALL_CORRECTIONS) {
        stallCorrections++;
        display.warning(
          `${what} — telling the model to change approach ` +
          `(nudge ${stallCorrections}/${MAX_STALL_CORRECTIONS}).`,
        );
        history.push({ role: 'user', content: stallCorrection(stall, profile.stallThreshold) });
        // The signatures that triggered this are still the tail of the list, so
        // without clearing them the very next turn re-fires the detector and
        // burns every remaining nudge on one stall.
        turnSignatures.length = 0;
        stall = null;
      } else {
        display.warning(`${what}, and ${MAX_STALL_CORRECTIONS} corrections did not change it — stopping loop.`);
        break;
      }
    }

    if (primaryArgLoopReason) {
      display.warning(`Archimedes repetition loop — escalating early: ${primaryArgLoopReason}`);
      break;
    }

    display.agentThinking();
  }

  await persist(opts.sessionPath, history);
  const sessionId = opts.sessionPath ? path.basename(opts.sessionPath, '.json') : undefined;
  const resumeHint = sessionId ? ` Type /continue to resume session ${sessionId}` : '';
  const capDesc = turnCeiling === Infinity ? 'none' : String(turnCeiling);
  const reason = primaryArgLoopReason ? primaryArgLoopReason
    : stall === 'repeat' ? `stalled (repeated identical tool calls; ${MAX_STALL_CORRECTIONS} corrections ignored)`
    : stall === 'cycle' ? `stalled (cycling between the same two tool calls; ${MAX_STALL_CORRECTIONS} corrections ignored)`
    : budgetStop ? describeBudgetStop(budgetStop)
    : `ended after ${turns} turns (cap: ${capDesc})`;
  // ── The knowledge-gap pass ────────────────────────────────────────────────
  //
  // This is the last moment before the run is thrown away, and it is the one
  // place where spending more tokens is clearly worth it: the alternative
  // outcome is nothing at all. Ask what was missing, look it up in what Aura
  // already knows, research it only on a miss, then resume the task with the
  // answer in hand and write the lesson down so the next run gets it free.
  //
  // Skipped when the user pulled the handbrake — an abort means stop, and
  // "stop" must not be answered with more work. Skipped for a budget stop for
  // the same reason: the ceiling that just fired is the one thing a recovery
  // pass would blow straight through.
  const gapEligible = !opts.noGapPass
    && !opts.abortSignal?.aborted
    && !budgetStop
    && turns > 0;

  if (gapEligible) {
    const { runKnowledgeGapPass, formatResumption } = await import('./learning.js');
    const gap = await runKnowledgeGapPass({
      provider, system, history, task: opts.task,
      context: opts.context, display,
      abortSignal: opts.abortSignal,
      budget: opts.budget,
    });

    if (gap.resolved) {
      display.success(`Resuming with what was missing (via ${gap.via}).`);
      // A fresh invocation rather than re-entering the while loop: the resumed
      // run needs its own turn budget, and expressing that as a new call keeps
      // the recursion depth visible instead of hidden in a mutated counter.
      // noGapPass makes it terminal — one recovery per run, never a chain.
      const resumed = await runAgentLoop({
        ...opts,
        initialHistory: history,
        task: formatResumption(gap, opts.task),
        noGapPass: true,
        images: undefined,
      });
      // Report what the whole recovery cost, not just the resumed leg. This
      // matters more here than anywhere else in the loop: the gap pass is the
      // one path that spends tokens the user did not directly ask for, so
      // under-reporting it would hide exactly the number they need to judge
      // whether it is worth keeping on.
      return {
        ...resumed,
        turns: turns + resumed.turns,
        toolCallCount: toolCallCount + resumed.toolCallCount,
        usage: {
          inputTokens:  usage.inputTokens  + resumed.usage.inputTokens,
          outputTokens: usage.outputTokens + resumed.usage.outputTokens,
          totalTokens:  usage.totalTokens  + resumed.usage.totalTokens,
          cachedTokens: (usage.cachedTokens ?? 0) + (resumed.usage.cachedTokens ?? 0),
        },
        costUsd: (costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens) ?? 0)
               + (resumed.costUsd ?? 0),
      };
    }
  }

  return {
    success: false,
    summary: `Loop ${reason}.${resumeHint}`,
    turns, toolCallCount, usage, history, toolCallLog, turnUsage,
    costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
  };
}

export async function runAgentLoopVerified(
  opts: LoopOptions,
  config: VerificationConfig,
  projectRoot: string,
): Promise<{ loopResult: LoopResult; verifyResult: import('../verify/types.js').VerificationResult; totalAttempts: number }> {
  const { runWithVerification } = await import('../verify/index.js');
  return runWithVerification({ loopOpts: opts, config, projectRoot, display: opts.display });
}

async function persist(path: string | undefined, history: HistoryMessage[]): Promise<void> {
  if (!path) return;
  try { await sessionStore.save(path, history); }
  catch { /* persistence is best-effort */ }
}

/**
 * Appends one JSON line per compaction event to <root>/.aura/context-metrics.jsonl,
 * tagged by strategy, so old-vs-new (default vs AURA_CONTEXT_STRATEGY=tiered)
 * runs can be diffed after the fact independent of the live display.
 */
function logContextMetrics(root: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.join(root, '.aura');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'context-metrics.jsonl'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch { /* metrics logging is best-effort */ }
}

/** One per-call record in <root>/.aura/token-log.jsonl. */
export interface TokenLogEntry {
  turn: number;
  ts: string;
  model: string;
  input: number;
  output: number;
  cacheHit: number;
  cacheWrite: number;
  /** cacheHit / input, 0 when input is 0. The number that actually matters. */
  hitRatio: number;
  costUsd: number;
  sessionId?: string;
}

/**
 * Append one line per provider call to <root>/.aura/token-log.jsonl.
 *
 * Separate from context-metrics.jsonl (which only records compaction events):
 * a session can be ruinously expensive without ever compacting, which is
 * exactly the failure this exists to make visible. Cache hit ratio is the
 * dominant cost lever — a 98%-cached call costs ~1/10th of an uncached one at
 * the same token count — but it was previously invisible unless you dug
 * through session JSON after the fact.
 */
function logTokenUsage(root: string, entry: TokenLogEntry): void {
  try {
    const dir = path.join(root, '.aura');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'token-log.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* logging is best-effort — never break a run over telemetry */ }
}

function formatCallForConfirmation(call: ToolCall): string {
  if (call.name === 'run_shell') return `$ ${call.input.command}`;
  if (call.name === 'write_file') return `overwrite ${call.input.path}`;
  if (call.name === 'mcp' && call.input.action === 'connect') {
    const args = Array.isArray(call.input.args_list) ? (call.input.args_list as string[]).join(' ') : '';
    return `spawn MCP server '${call.input.server}': ${call.input.command} ${args}`.trim();
  }
  return `${call.name}(${JSON.stringify(call.input).slice(0, 80)})`;
}

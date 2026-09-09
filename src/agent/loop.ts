/**
 * The agent loop. It is the same four steps a coding assistant like Claude
 * Code runs — everything else in this file is hardening around them.
 *
 *   1. Read the message + context.
 *        `runAgentLoop` builds it: buildSystemPrompt(context) + initialHistory
 *        + the user task. Then, each pass of `runLoopBody`'s `while (true)`,
 *        before the model call: drain any mid-run steering the user typed and
 *        compact history if it has grown past the window.
 *
 *   2. Think, then act — call tools.
 *        Stream one model response; collect its text and its tool calls.
 *
 *   3. Observe the results, adjust, repeat.
 *        stopReason === 'done'  → step 4.
 *        otherwise              → run every tool call, append each result to
 *        history, and loop back to step 2.
 *        Guards that keep the loop honest live here: stall detection, the
 *        "described the work instead of doing it" nudge, empty-response retry,
 *        and the Archimedes repetition break.
 *
 *   4. Stop when the task is done and verified, and reply.
 *        On stopReason === 'done': push the assistant message, persist the
 *        session, return the summary. Verification is the `runWithVerification`
 *        wrapper that re-runs the loop against failing tests; a bare
 *        runAgentLoop call is steps 1–3 plus the reply.
 *
 * Turn-based: one runAgentLoop call is one user message carrying the whole
 * history forward. It does not run in the background — it advances on a
 * message, or when a spawned sub-agent returns.
 *
 * The cumulative guards (maxTurns per call, SessionBudget across a whole
 * conversation) only decide when to stop early; they do not change the shape
 * of the loop above.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { LLMProvider, HistoryMessage, ToolCall, ToolResult } from '../providers/types.js';
import { selectTools, selectToolsWithEviction, executeTool } from '../tools/index.js';
import { PermissionSystem } from '../safety/permissions.js';
import { confirm } from '../safety/permissions.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildTaskGuidance, TASK_GUIDANCE_DELIMITER } from './task-guidance.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';
import { sessionStore, type TurnUsage } from './session-store.js';
export type { TurnUsage };
import { registerSpawner, clearSpawner, makeDefaultSpawner } from './spawner.js';

// Default per-result ceiling for normal tool output — sized to cover a whole
// read_file result (read-file.ts caps full-file reads at ~15K chars), so the
// loop never re-cuts what the tool already sized. Small-model sessions pass
// toolResultMaxChars to narrow it.
const DEFAULT_TOOL_RESULT_CHARS = 24_000;
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
import {
  looksPromissory, MAX_PROMISE_NUDGES, PROMISE_CORRECTION,
  looksLikeUnparsedToolCall, MAX_UNPARSED_NUDGES, UNPARSED_TOOLCALL_CORRECTION,
  claimedNewFiles, claimsVerification, MAX_GROUND_NUDGES,
  missingFilesCorrection, UNRAN_VERIFICATION_CORRECTION,
  claimsCodeBlocker, proposesGuardWorkaround, blockerSymbolNames,
  MAX_BLOCKER_NUDGES, inventedBlockerCorrection,
} from './promise-guard.js';
import { ContextHealthTracker } from '../cli/context-health.js';
import { formatSteering, type SteeringInbox } from './steering.js';

/** How many times one task may have its reply cut off for collapsing into
 *  repetition before the run gives up on the model. Two, because the first
 *  correction usually lands and a third attempt is just paying for the same
 *  failure again. */
const MAX_REPETITION_RETRIES = 2;

/**
 * If a write_file call just wrote a previewable file (HTML, SVG, Markdown),
 * extract an artifact descriptor so the client can render it inline. Returns
 * undefined for anything that is not worth previewing.
 */
function artifactFromWriteFile(
  toolName: string,
  input: Record<string, unknown>,
): { id: string; name: string; content: string; contentType: string } | undefined {
  if (toolName !== 'write_file') return undefined;
  const filePath = String(input.path ?? '');
  const ext = path.extname(filePath).toLowerCase();
  const content = String(input.content ?? '');
  const map: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html',
    '.svg':  'image/svg+xml',
    '.md':   'text/markdown',
  };
  const contentType = map[ext];
  if (!contentType || !content) return undefined;
  const name = path.basename(filePath);
  const id = crypto.createHash('sha1').update(`${name}:${content.length}`).digest('hex').slice(0, 12);
  return { id, name, content, contentType };
}

/** Sent after a collapsed reply is cut off. Names the failure, then aims the
 *  model at the tool call it was narrating instead of making. */
const REPETITION_CORRECTION =
  'Your previous reply collapsed: it repeated the same phrase over and over until it was cut off. ' +
  'Do not describe or narrate what you are about to write. Make the tool call directly — ' +
  'call write_file once with the complete file content. If the file is genuinely too large for one ' +
  'call, write a first section with write_file and append the rest with follow-up edit_file calls.';

/** A single reply that streams this many characters of prose without ever
 *  calling a tool is a runaway — the model has stopped working and started
 *  free-associating (observed: an 88k-token planning monologue from
 *  glm-5.3-flash that never produced a file). ~8k tokens; a real answer or
 *  a pre-tool plan is a fraction of this, and cutting at 32k saves the other
 *  ~80k of output the spiral would otherwise bill. */
const RUNAWAY_TEXT_CHARS = 32_000;
const MAX_RUNAWAY_RETRIES = 2;

/** Sent after a runaway monologue is cut off. */
const RUNAWAY_CORRECTION =
  'Your previous reply ran on for thousands of words without calling a tool or finishing — it ' +
  'drifted off the task into open-ended narration. Stop planning in prose. In this reply do exactly ' +
  'one of: (a) make the next concrete tool call (read_file, write_file, run_shell, …) that moves the ' +
  'task forward, or (b) if the task is done, give a summary of at most 5 sentences. Keep any reasoning ' +
  'to two or three sentences.';

/** How many times a stalled run may be nudged to change approach before it
 *  gives up. Three, because a stall is usually one wrong idea the model keeps
 *  re-deriving, and naming it back is often enough to break it — but a model
 *  that ignores three explicit corrections is not going to obey a fourth. */
const MAX_STALL_CORRECTIONS = 3;

/** No-progress ("spin") guard. A run that keeps calling tools turn after turn
 *  without ever changing state (no write_file/edit_file/run_shell/run_tests)
 *  and without reading anything *new* is re-verifying an already-reached state
 *  rather than moving forward. Observed as a 300+ turn / 5.5-hour run that
 *  removed one modal then spent ~50 turns re-screenshotting and re-reading the
 *  already-done page (session 24eebc25) — each call differed, so detectStall
 *  never fired, but every one returned the same artifact.
 *
 *  Reading a resource that has not been seen this run is exploration and resets
 *  the streak: a real task surveys new files before it writes. Only re-checking
 *  already-seen targets (the same file at a different window, the same page at
 *  a different selector) is a spin. */
const NO_PROGRESS_LIMIT = 8;

/** How many times a spinning run may be nudged before it is stopped. The
 *  streak is not reset by a nudge (see the guard in the loop body), so a pure
 *  spin hard-stops a turn after these run out: NO_PROGRESS_LIMIT turns to
 *  first fire, then one turn per correction. */
const MAX_NO_PROGRESS_CORRECTIONS = 2;

/** Sent when the no-progress guard fires. Names the loop concretely, then lets
 *  the model keep working if it genuinely has an open question, but demands it
 *  either conclude or make a state-changing call. */
function noProgressCorrection(turnsSpun: number): string {
  return `You have now spent ${turnsSpun} turns calling tools without changing anything on disk ` +
    'or running anything — you are only reading and re-verifying. If the task is complete, stop ' +
    'calling tools and give your final summary now. If you are still gathering information, say in ' +
    'one sentence the specific open question you are resolving, then make the call that resolves it. ' +
    'Do not run another verification pass of the same already-confirmed state.';
}

/** The stable resource a read-only call inspects, when the spin guard can name
 *  one — else nothing. Keyed by the target path/URL only, ignoring the call's
 *  other parameters, so re-reading a file at different line ranges or
 *  re-screenshotting a page at different selectors still collapses to the same
 *  resource: that is the re-verification shape (session 24eebc25). Calls with
 *  no identifiable target — search queries, directory listings, everything
 *  else — return nothing, so the guard treats them as new input and never fires
 *  on calls it cannot see are repeats. */
function spinResourceKeys(calls: readonly ToolCall[]): string[] {
  const keys: string[] = [];
  for (const c of calls) {
    const target = typeof c.input?.path === 'string' && c.input.path
      ? c.input.path
      : typeof c.input?.url === 'string' && c.input.url
        ? c.input.url
        : undefined;
    if (target !== undefined) keys.push(`${c.name}:${target}`);
  }
  return keys;
}

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
  /** Base config passed to spawned sub-agents: credentials for the session's
   *  provider, and an optional default model (the loop falls back to the
   *  session's own model when unset). */
  spawnConfig?: { apiKey?: string; baseUrl?: string; model?: string };
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
  cacheCreationTokens?: number;
}

/**
 * Read-only, deterministic tools whose result depends solely on workspace
 * state. Safe to serve from the per-run cache until something mutates.
 * Deliberately excludes non-deterministic tools (web_fetch, web_search,
 * http_request, browser) and anything with side effects.
 */
/**
 * Does any file under `root` define/mention any of `symbols`? Grounding for
 * the invented-blocker check: a reply that negotiates with "check_target"
 * when nothing in the repo defines check_target is negotiating with fiction.
 * Bounded walk — this only runs when the prose predicate already matched, so
 * the cost is paid rarely. Fails OPEN: if the tree cannot be searched we
 * assume the symbol exists rather than nudge on our own blindness.
 */
const BLOCKER_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv']);
async function repoDefinesAnySymbol(root: string, symbols: string[]): Promise<boolean> {
  const needles = symbols.map((sym) => sym.toLowerCase());
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 8 || visited > 20_000) return false;
    let entries: import('fs').Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (visited > 20_000) return false;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (BLOCKER_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (await walk(full, depth + 1)) return true;
      } else if (e.isFile()) {
        visited++;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > 2_000_000) continue;
          const text = await fs.promises.readFile(full, 'utf8');
          const low = text.toLowerCase();
          if (needles.some((n) => low.includes(n))) return true;
        } catch { /* unreadable file — skip */ }
      }
    }
    return false;
  };
  try { return await walk(root, 0); } catch { return true; }
}

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

/**
 * Tools worth checking for byte-identical results across *different* inputs.
 *
 * Distinct from CACHEABLE_READ_TOOLS, and deliberately so: these are the
 * non-deterministic fetchers, which must never be served from cache. This is
 * detection, not caching — the call still executes and the model still gets a
 * fresh result. All that is added is a note when the bytes are ones it has
 * already seen.
 *
 * The case that motivated it: an SPA host (Vercel, Netlify, most static hosts)
 * answers *every* unmatched path with index.html and HTTP 200. An agent hunting
 * for a stylesheet fetched /style.css, /index.css, / with different max_chars —
 * five distinct URLs, five "successful" 200s, byte-identical HTML every time.
 * The signature cache could not see it (different inputs ⇒ different keys) and
 * stall detection compares calls rather than results, so nothing noticed until
 * the calls themselves repeated verbatim. Meanwhile each identical payload was
 * re-injected into context at full size.
 */
const CONTENT_DEDUPE_TOOLS = new Set([
  'web_fetch', 'web_search', 'http_request',
]);

/**
 * Cheap fingerprint of a fetch result's *payload*, ignoring its metadata block.
 *
 * Not cryptographic — only equality matters.
 *
 * Every tool in CONTENT_DEDUPE_TOOLS prints a metadata preamble terminated by a
 * blank line (`HTTP 200`, `Content-Type: …`, `URL: …`, and any warning), then the
 * body. That preamble echoes the request, so hashing the whole string would make
 * two fetches of the same page look different purely because their URLs differ —
 * which is exactly the case this check exists to catch. So the preamble is
 * dropped and only the payload is hashed. Results with no blank line are hashed
 * whole.
 */
function contentHash(text: string): string {
  const sep = text.indexOf('\n\n');
  const body = sep === -1 ? text : text.slice(sep + 2);
  return crypto.createHash('sha1').update(body).digest('hex');
}

/**
 * The " Type :resume …" tail appended to a stalled loop's summary.
 *
 * Exported for tests, and kept honest about two things the old inline version
 * got wrong. The command is `:resume` — the REPL matches colon-prefixed input
 * and has no slash-command dispatcher, so `/continue` was never a command and
 * typing it just sent the literal text to the model as a prompt. And an id is
 * only quoted when it is a real session id; `latest.json` is a per-project
 * scratch file every run overwrites, so "resume session latest" pointed at
 * whichever task happened to finish last rather than at this one.
 */
export function resumeHintFor(sessionPath: string | undefined): string {
  if (!sessionPath) return '';
  // The loop's crash-safety file is `<id>.run.json`, held apart from the session
  // record `<id>.json` because the two carry different shapes (see the
  // sessionPath comment in cli/index.ts). The id to resume is the same either
  // way, so the marker suffix comes off before validating.
  const id = path.basename(sessionPath, '.json').replace(/\.run$/, '');
  // Ids come from sessionStore.generateId(): 8 hex chars, '-', base36 stamp.
  const isRealId = /^(gazelle-)?[0-9a-f]{8}-[0-9a-z]+$/.test(id);
  return isRealId
    ? ` Type :resume ${id} to continue this session.`
    : ' Type :resume to continue the most recent session.';
}

const PRICING_USD_PER_MTOK: Record<string, { in: number; out: number; cachedIn?: number; cacheWriteIn?: number }> = {
  // cacheWriteIn = 1.25x input: Anthropic bills cache_control writes at 1.25x
  // the base input rate, and its usage.input_tokens excludes both written and
  // read cache tokens — see costFor below.
  'claude-opus-4-5-20251001':   { in: 15,  out: 75,  cacheWriteIn: 18.75 },
  'claude-sonnet-4-5-20251001': { in: 3,   out: 15,  cacheWriteIn: 3.75  },
  'claude-haiku-4-5-20251001':  { in: 0.8, out: 4,   cacheWriteIn: 1     },
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

export function costFor(model: string, input: number, output: number, cachedTokens?: number, cacheCreationTokens?: number): number {
  const p = PRICING_USD_PER_MTOK[model] ?? PRICING_USD_PER_MTOK[Object.keys(PRICING_USD_PER_MTOK).find(k => model.includes(k.split('-')[1] ?? '') && k.startsWith(model.split('-')[0] ?? '')) ?? ''] ?? { in: 0, out: 0 };
  const cached = Math.min(cachedTokens ?? 0, input);
  const billable = input - cached;
  const cachedRate = p.cachedIn ?? p.in / 10;
  // Cache writes are only billed as a separate line by Anthropic (1.25x input,
  // input_tokens excluding them), and only its adapter reports
  // cacheCreationTokens. Other providers auto-cache — writes are plain input
  // there or not billed at all — so without a cacheWriteIn row entry the
  // tokens are not re-priced, avoiding double counting an input figure that
  // already includes them.
  const created = Math.max(0, cacheCreationTokens ?? 0);
  const writeRate = p.cacheWriteIn ?? 0;
  return (billable / 1_000_000) * p.in + (cached / 1_000_000) * cachedRate + (created / 1_000_000) * writeRate + (output / 1_000_000) * p.out;
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

  const system = opts.systemPromptOverride ?? buildSystemPrompt(context, provider.name);
  // Task-derived guidance (domain expertise, conditional plugin skills) rides
  // on the kickoff user message rather than the system prompt — see
  // task-guidance.ts. Skipped when the caller owns the prompt (orchestration
  // specialists), whose tasks were never the source of these blocks. The
  // history copy only is wrapped: the caller's `task` string stays clean for
  // display, tools gating and budget messages, and selectTools() re-gates on
  // this message below via stripTaskGuidance-cleaned history.
  const useDefaultPrompt = !opts.systemPromptOverride;
  const guidance = useDefaultPrompt ? buildTaskGuidance(task) : '';
  const kickoffContent = guidance
    ? `${finalTask}${TASK_GUIDANCE_DELIMITER}${guidance}`
    : finalTask;
  const history: HistoryMessage[] = [
    ...(opts.initialHistory ?? []),
    { role: 'user', content: kickoffContent, ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}) },
  ];

  let turns = 0;
  let toolCallCount = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };

  if (!opts.disableSpawn) {
    // The session's own model is the sub-agent default — a hardcoded name is a
    // private deal with one provider and 404s for everyone else. A caller may
    // still pin a different default via spawnConfig.model.
    registerSpawner(makeDefaultSpawner(
      context,
      { model: provider.model, ...(opts.spawnConfig ?? {}) },
      display,
    ));
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

  // content hash -> the call signature that first produced it, for the
  // non-deterministic fetchers. Lets an identical *result* from a different
  // *input* be named as such instead of silently re-injected; see
  // CONTENT_DEDUPE_TOOLS. Never used to skip a call.
  const seenContent = new Map<string, string>();

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
  // No-progress ("spin") detection. Consecutive tool-calling turns that change
  // no state and read nothing new (see NO_PROGRESS_LIMIT above); reset by any
  // mutating turn or by a read of a not-yet-seen resource.
  let spinStreak = 0;
  let spinCorrections = 0;
  let spinStopped = false;
  // Read targets seen so far. A no-mutation turn whose calls all hit targets
  // already in here is re-verification; one that touches anything new is
  // exploration and clears the streak (the set is kept so a later re-read of
  // an earlier target still counts as a repeat).
  const spinSeen = new Set<string>();
  // Successful state-changing calls across the whole run, by kind. Used at the
  // "done" boundary to check a completion claim against what actually ran: a
  // reply that says it wrote a file or that the tests pass, with zero calls of
  // the matching kind, is not to be trusted (see the ungrounded-claim gate).
  let writeCalls = 0;   // write_file, edit_file
  let execCalls = 0;    // run_shell, run_tests

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
    // Non-repeating runaway: coherent text that never stops and never calls a
    // tool. The repetition guard misses it because every sentence is new.
    let runaway = false;

    try {
      let tools = evictionEnabled
        ? selectToolsWithEviction(opts.task, history, includedTools, lastUsedTurn, turns, evictAfterTurns, evictedTools)
        : selectTools(opts.task, history, includedTools);
      if (allowedToolNames) tools = tools.filter(t => allowedToolNames.has(t.name));
      const stream = provider.stream(system, history, tools);
      streamLoop: for await (const chunk of stream) {
        switch (chunk.type) {
          case 'text':
            // A mid-stream abort: :stop / Ctrl+C while the model is still
            // generating. The between-turns check (top of the loop) can't help
            // a model that is 60 seconds into one runaway response.
            if (opts.abortSignal?.aborted) break streamLoop;
            display.streamText(chunk.text);
            responseText += chunk.text;
            // Breaking out returns the generator, which aborts the request, so
            // the provider stops generating (and billing) the rest of the loop.
            repetition = repGuard.push(chunk.text);
            if (repetition) break streamLoop;
            if (responseText.length > RUNAWAY_TEXT_CHARS && responseToolCalls.length === 0) {
              runaway = true;
              break streamLoop;
            }
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
              usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0);
              // Net of cache hits, not raw prompt size — this is the ceiling
              // that actually tracks cost across conversation segments.
              opts.budget?.recordCall(inT, cachedT);
              const at = new Date().toISOString();
              const turnCost = costFor(pricingModel, inT, outT, cachedT, u.cacheCreationTokens ?? 0);
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
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens),
      };
    }

    if (responseText) display.streamEnd();

    // The stream ended without a `done` chunk — a runaway/repetition cut-off or
    // a mid-stream abort. The provider still billed the tokens it generated, so
    // estimate them rather than leave usage (and therefore /stats and the
    // session budget) reading zero for a turn that plainly happened.
    if (finalResponse === null && (responseText.length > 0 || responseToolCalls.length > 0)) {
      // Only the LoopResult rollup and the session budget — not turnUsage,
      // which is documented as coming straight from API responses.
      const estIn = estimateContextTokens(system, history);
      const estOut = Math.ceil(responseText.length / 4);
      usage.inputTokens += estIn;
      usage.outputTokens += estOut;
      usage.totalTokens += estIn + estOut;
      opts.budget?.recordCall(estIn, 0);
    }

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
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens),
      };
    }

    // The reply ran away — thousands of words, no tool call, drifting off task.
    // Same discipline as the repetition guard: keep only a short head so the
    // model isn't shown its own spiral, name the failure, and give it a couple
    // of tries before declaring it a model failure.
    if (runaway) {
      loopState._runawayRetries = ((loopState._runawayRetries as number) ?? 0) + 1;
      const attempts = loopState._runawayRetries as number;
      display.warning(
        `Reply ran away (${responseText.length.toLocaleString()} chars, no tool call) — cut off` +
        (attempts <= MAX_RUNAWAY_RETRIES ? ' and retrying with a correction…' : '.'),
      );
      if (attempts <= MAX_RUNAWAY_RETRIES) {
        const head = responseText.trim().slice(0, 200);
        history.push({
          role: 'assistant',
          content: `${head}\n[reply cut off: ran on for ${responseText.length.toLocaleString()} characters without calling a tool]`,
        });
        history.push({ role: 'user', content: RUNAWAY_CORRECTION });
        display.agentThinking();
        continue;
      }
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary:
          `The model's reply ran away ${attempts}× — long, drifting monologues with no tool call. ` +
          `This is a model failure, not a task failure: try a narrower step, or a stronger model ` +
          `with --model / :model (glm-*-flash is prone to this).`,
        turns, toolCallCount, usage, history, toolCallLog, turnUsage,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens),
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
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens),
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

      // ── Ungrounded completion: the reply says done, reality disagrees ──────
      // All three checks are grounded in what actually ran, not in prose:
      //   1. a tool call emitted as text — the provider parsed nothing, so it
      //      never executed, but the model believes it did.
      //   2. a file the reply names as created that is not on disk.
      //   3. "the tests pass" after code changes, with nothing executed.
      const unparsedCall =
        responseToolCalls.length === 0 && looksLikeUnparsedToolCall(responseText);
      const missingFiles = claimedNewFiles(responseText).filter((f) => {
        try { return !fs.existsSync(path.resolve(opts.context.root, f)); }
        catch { return false; }
      });
      const unranVerification =
        writeCalls > 0 && execCalls === 0 && claimsVerification(responseText);

      // 4. an invented obstacle: the reply asserts a code-level refusal AND
      //    plans to work around it, but no file in the repo defines the named
      //    mechanism — the guard is fiction (see promise-guard.ts).
      const blockerSymbols = blockerSymbolNames(responseText);
      const inventedBlocker = claimsCodeBlocker(responseText)
        && proposesGuardWorkaround(responseText)
        && blockerSymbols.length > 0
        && !(await repoDefinesAnySymbol(opts.context.root, blockerSymbols));

      if (unparsedCall && (loopState._unparsedNudges ?? 0) < MAX_UNPARSED_NUDGES) {
        loopState._unparsedNudges = (loopState._unparsedNudges ?? 0) + 1;
        display.warning(
          `A tool call was written as text and never ran — correcting ` +
          `(${loopState._unparsedNudges}/${MAX_UNPARSED_NUDGES}).`,
        );
        history.push({ role: 'assistant', content: responseText });
        history.push({ role: 'user', content: UNPARSED_TOOLCALL_CORRECTION });
        display.agentThinking();
        continue;
      }

      if (inventedBlocker && (loopState._blockerNudges ?? 0) < MAX_BLOCKER_NUDGES) {
        loopState._blockerNudges = (loopState._blockerNudges ?? 0) + 1;
        display.warning(
          `Reply negotiates with a code guard the repo does not define — correcting ` +
          `(${loopState._blockerNudges}/${MAX_BLOCKER_NUDGES}).`,
        );
        history.push({ role: 'assistant', content: responseText });
        history.push({ role: 'user', content: inventedBlockerCorrection(blockerSymbols) });
        display.agentThinking();
        continue;
      }

      if ((missingFiles.length > 0 || unranVerification)
          && (loopState._groundNudges ?? 0) < MAX_GROUND_NUDGES) {
        loopState._groundNudges = (loopState._groundNudges ?? 0) + 1;
        const parts: string[] = [];
        if (missingFiles.length > 0) parts.push(missingFilesCorrection(missingFiles));
        if (unranVerification) parts.push(UNRAN_VERIFICATION_CORRECTION);
        display.warning(
          `Completion claim not backed by what ran — pushing back ` +
          `(${loopState._groundNudges}/${MAX_GROUND_NUDGES}).`,
        );
        history.push({ role: 'assistant', content: responseText });
        history.push({ role: 'user', content: parts.join('\n\n') });
        display.agentThinking();
        continue;
      }

      const ungrounded = unparsedCall || missingFiles.length > 0 || unranVerification || inventedBlocker;
      const ungroundedNote = !ungrounded ? '' :
        unparsedCall ? 'a tool call was written as text and did not run' :
        missingFiles.length > 0 ? `claimed file(s) not on disk: ${missingFiles.join(', ')}` :
        inventedBlocker ? `negotiated with guard(s) no repo code defines: ${blockerSymbols.slice(0, 3).join(', ')}` :
        'the tests were said to pass but were never run';

      history.push({ role: 'assistant', content: responseText });
      await persist(opts.sessionPath, history);
      return {
        // Not a success if it never acted (a promise) or if the completion
        // claim did not survive the reality check above — a false "Done" is
        // what sends the user back to retype the task.
        success: !(toolCallCount === 0 && looksPromissory(responseText)) && !ungrounded,
        summary: ungrounded
          ? `${responseText}\n\n[Aura: unverified — ${ungroundedNote}.]`
          : responseText,
        turns, toolCallCount, usage, history, toolCallLog, turnUsage,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens),
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

    // Snapshot the state-change counters so this turn's mutation (if any) can
    // be told apart from the run's cumulative total — the no-progress ("spin")
    // guard keys on turns that change nothing.
    const turnStartWrites = writeCalls + execCalls;

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
            // Surface previewable artifacts to the client. write_file carries the
            // full content in its input, so we can emit inline without re-reading.
            const artifact = artifactFromWriteFile(call.name, call.input);
            if (artifact && display.artifact) display.artifact(artifact);
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
        // The default covers a whole read_file result (read-file.ts caps
        // full-file reads at ~15K chars): a cap below that re-cuts what the
        // tool already sized, and the model pays a full extra turn per chunk
        // to re-read what one call could have carried.
        const normalLimit = opts.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_CHARS;
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
        // Byte-identical result from a *different* call — an SPA fallback, a
        // redirect that collapses several URLs onto one page, or a search that
        // keeps returning the same hits. The result stands (these tools are
        // never served from cache); it is only labelled, so the model stops
        // guessing at new inputs that resolve to content it already has.
        if (CONTENT_DEDUPE_TOOLS.has(call.name) && !isError) {
          const hash = contentHash(result);
          const firstSig = seenContent.get(hash);
          if (firstSig === undefined) {
            seenContent.set(hash, sig);
          } else if (firstSig !== sig) {
            result += `\n\n[identical to the earlier ${firstSig} result — byte for byte.`
              + ` Different inputs are resolving to the same content, so guessing further`
              + ` variants will not yield anything new. Change approach.]`;
          }
        }
        toolCallLog.push({ name: call.name, input: call.input });
        if (!isError) {
          execQueue.push(call.name, call.input, turns);
          if (call.name === 'write_file' || call.name === 'edit_file') writeCalls++;
          else if (call.name === 'run_shell' || call.name === 'run_tests') execCalls++;
        }

        if (opts.hooks && opts.hooks.length > 0) {
          const { runHooks } = await import('../plugins/hooks.js');
          await runHooks('PostToolUse', call.name, call.input, opts.hooks, opts.context.root, result);
        }
      } catch (e) {
        result = `Tool error (${call.name}): ${String(e)}`;
        isError = true;
        display.error(result);
      }
      // Safety net: a misbehaving tool that ignores its own output caps must
      // not eat the context in one bite. It sits above the normal limit, so
      // legitimate results (reads, searches) pass untouched and only a tool
      // bug ever reaches it.
      const MAX_TOOL_RESULT_CHARS = Math.max(8_000, (opts.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_CHARS) + 8_000);
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
        // A repeat/cycle is the stall detector's to manage — it owns identical
        // and alternating calls and gives the model three chances to change
        // before stopping. Reset the spin streak so a same-two-calls loop is
        // resolved by stall at its gentler cadence, not pre-empted here.
        spinStreak = 0;
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

    // No-progress ("spin") guard: this turn called tools but changed nothing
    // (no write/edit/shell/test) and read nothing new. Enough such turns in a
    // row means the run is re-verifying an already-reached state rather than
    // moving forward. Nudge, then hard-stop after the nudges run out — mirrors
    // the stall path above. The streak is NOT reset by a nudge: once it clears
    // NO_PROGRESS_LIMIT it stays past it, so an unheeding spinner is nudged on
    // the following turns too and hard-stopped a turn after the corrections are
    // exhausted, instead of buying itself another NO_PROGRESS_LIMIT turns per
    // nudge. Reading a brand-new resource resets it — that is exploration.
    if (responseToolCalls.length > 0) {
      if ((writeCalls + execCalls) === turnStartWrites) {
        const keys = spinResourceKeys(responseToolCalls);
        let sawNew = false;
        for (const k of keys) {
          if (!spinSeen.has(k)) sawNew = true;
          spinSeen.add(k);
        }
        // No keyable target at all (calls the guard cannot classify) is treated
        // as new input too — fail open, never fire on something we cannot see
        // is a repeat.
        if (keys.length === 0 || sawNew) {
          spinStreak = 0;
        } else {
          spinStreak++;
          if (spinStreak >= NO_PROGRESS_LIMIT) {
            if (spinCorrections < MAX_NO_PROGRESS_CORRECTIONS) {
              spinCorrections++;
              display.warning(
                `${NO_PROGRESS_LIMIT}+ straight turns with no change to disk — telling the model to ` +
                `conclude or act (nudge ${spinCorrections}/${MAX_NO_PROGRESS_CORRECTIONS}).`,
              );
              history.push({ role: 'user', content: noProgressCorrection(spinStreak) });
            } else {
              display.warning(
                `${NO_PROGRESS_LIMIT}+ straight turns with no change to disk, and ` +
                `${MAX_NO_PROGRESS_CORRECTIONS} corrections did not break the loop — stopping.`,
              );
              spinStopped = true;
              break;
            }
          }
        }
      } else {
        // A mutating turn resets the streak and forgets what has been read.
        spinStreak = 0;
        spinSeen.clear();
      }
    }

    if (primaryArgLoopReason) {
      display.warning(`Archimedes repetition loop — escalating early: ${primaryArgLoopReason}`);
      break;
    }

    display.agentThinking();
  }

  await persist(opts.sessionPath, history);
  // The hint has to name a command that exists and an id that resolves, or it
  // sends the user somewhere that cannot work. It previously read
  // "Type /continue to resume session <id>": there is no /continue — the REPL
  // has no slash commands at all, only colon ones — so the text went to the
  // model as an ordinary user message and came back as an unrelated answer
  // about whatever the model could infer. The id was wrong too: sessionPath is
  // a fixed `latest.json` per project, so basename() yielded the literal
  // "latest" rather than a session id, and `:resume latest` would have loaded
  // whichever run last touched that shared file.
  const resumeHint = resumeHintFor(opts.sessionPath);
  const capDesc = turnCeiling === Infinity ? 'none' : String(turnCeiling);
  const reason = primaryArgLoopReason ? primaryArgLoopReason
    : spinStopped ? `stopped (${NO_PROGRESS_LIMIT}+ straight turns with no change to disk; ${MAX_NO_PROGRESS_CORRECTIONS} corrections ignored)`
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
          cacheCreationTokens: (usage.cacheCreationTokens ?? 0) + (resumed.usage.cacheCreationTokens ?? 0),
        },
        costUsd: (costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens) ?? 0)
               + (resumed.costUsd ?? 0),
      };
    }
  }

  return {
    success: false,
    summary: `Loop ${reason}.${resumeHint}`,
    turns, toolCallCount, usage, history, toolCallLog, turnUsage,
    costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.cacheCreationTokens),
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

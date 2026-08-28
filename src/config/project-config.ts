import * as fs from 'fs';
import * as path from 'path';
import type { ArchimedesBackend } from '../archimedes/types.js';
import { parseEffort, type EffortLevel } from '../providers/effort.js';

/**
 * Definition of a custom provider in .aura.json.
 * Allows users to add new OpenAI-compatible endpoints without code changes.
 */
export interface ProviderDef {
  /** Display name (e.g. "DeepSeek", "My Proxy") */
  name: string;
  /** API base URL (e.g. "https://api.deepseek.com/v1") */
  baseUrl: string;
  /** Env var name that holds the API key (e.g. "DEEPSEEK_API_KEY") */
  apiKeyEnv?: string;
  /** Static API key (less secure, prefer apiKeyEnv) */
  apiKey?: string;
  /** Model name prefixes that route to this provider (e.g. ["deepseek/"]) */
  prefixes: string[];
  /** Known models this provider offers (shown in the model selector) */
  models?: { id: string; name?: string; speed?: string }[];
}

export interface ProjectConfig {
  model?: string;
  baseUrl?: string;
  /** Reasoning effort rung — see providers/effort.ts for the ladder. */
  effort?: EffortLevel;
  mode?: 'normal' | 'read-only' | 'auto';
  maxTurns?: number;
  ignore?: string[];
  systemPromptSuffix?: string;
  /** Custom providers defined in .aura.json */
  providers?: ProviderDef[];
  /** Resilience: requests per minute. */
  rateLimitRpm?: number;
  /** Resilience: tokens per minute (Gemini). */
  rateLimitTpm?: number;
  /** Resilience: max retry attempts. */
  maxRetries?: number;
  /** Resilience: fallbacks tried if primary fails. */
  fallbacks?: string[];
  /** Enable post-task verification. */
  verify?: boolean;
  /** Max verification retries (default: 3). */
  maxVerifyRetries?: number;
  /** Shell command to run as part of verification (e.g. "npm test"). */
  testCommand?: string;
  /** Preset profile — "local" routes to Ollama with compact prompts. */
  profile?: 'local';
  /** Shadow-git checkpoints before mutating tool calls (default: true). */
  checkpoints?: boolean;
  /** Context-management policy. */
  context?: {
    /**
     * Compaction trigger ladder as window fractions, ascending — one rung per
     * recap generation (default [0.55, 0.70, 0.85]). Lower rungs compact
     * sooner: cheaper per turn, but more summarization passes. Tunable
     * interactively via `/context tune`.
     */
    ladder?: number[];
    /**
     * Absolute ceiling in tokens before compaction fires (default 80000).
     * The ladder alone is window-relative, which stops bounding cost on
     * large-window models — a 1M-window model wouldn't compact until 550k.
     * Set 0 to disable and use the ladder alone.
     */
    maxTokens?: number;
  };
  /** Archimedes alternator — small-local-model-first routing (single-task path). */
  archimedes?: {
    enabled?: boolean;
    /** Local model id, optionally prefixed `ollama/` or `lmstudio/`. */
    modelName?: string;
    /** Which local server to use; inferred from a modelName prefix when omitted. */
    backend?: ArchimedesBackend;
    ollamaBaseUrl?: string;
    lmstudioBaseUrl?: string;
    competenceThreshold?: number;
    minAttempts?: number;
    epsilonProbeRate?: number;
    /** Model that verifies answers; omitted = the large model grades itself. */
    verifierModel?: string;
  };
}

/**
 * Load .aura.json from the project root (or any ancestor).
 * Returns an empty object if no file is found. Silently ignores parse errors
 * so a malformed config file doesn't brick the CLI.
 */
export function loadProjectConfig(cwd: string): ProjectConfig {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    const p = path.join(dir, '.aura.json');
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        return normalise(raw);
      } catch {
        return {};
      }
    }
    if (dir === root) return {};
    dir = path.dirname(dir);
  }
}

function normalise(raw: unknown): ProjectConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: ProjectConfig = {};
  if (typeof r.model === 'string') out.model = r.model;
  if (typeof r.baseUrl === 'string') out.baseUrl = r.baseUrl;
  // An unparseable rung is dropped rather than forwarded — sending it would
  // 400 every request in the project instead of failing one command.
  const effort = parseEffort(r.effort);
  if (effort) out.effort = effort;
  if (r.mode === 'normal' || r.mode === 'read-only' || r.mode === 'auto') out.mode = r.mode;
  if (r.maxTurns === 0 || r.maxTurns === false || r.maxTurns === 'off' || r.maxTurns === 'none' || r.maxTurns === Infinity) {
    out.maxTurns = Infinity;
  } else if (typeof r.maxTurns === 'number' && r.maxTurns > 0) {
    out.maxTurns = r.maxTurns;
  }
  if (typeof r.systemPromptSuffix === 'string') out.systemPromptSuffix = r.systemPromptSuffix;
  if (typeof r.rateLimitRpm === 'number' && r.rateLimitRpm >= 0) out.rateLimitRpm = r.rateLimitRpm;
  if (typeof r.rateLimitTpm === 'number' && r.rateLimitTpm >= 0) out.rateLimitTpm = r.rateLimitTpm;
  if (typeof r.maxRetries === 'number' && r.maxRetries > 0) out.maxRetries = Math.floor(r.maxRetries);
  if (Array.isArray(r.fallbacks)) {
    out.fallbacks = r.fallbacks.filter((x): x is string => typeof x === 'string');
  }
  if (Array.isArray(r.ignore)) out.ignore = r.ignore.filter((x): x is string => typeof x === 'string');
  if (r.verify === true || r.verify === false) out.verify = r.verify as boolean;
  if (typeof r.maxVerifyRetries === 'number' && r.maxVerifyRetries > 0) out.maxVerifyRetries = Math.floor(r.maxVerifyRetries as number);
  if (typeof r.testCommand === 'string') out.testCommand = r.testCommand as string;
  if (r.profile === 'local') out.profile = 'local';
  if (r.checkpoints === true || r.checkpoints === false) out.checkpoints = r.checkpoints as boolean;
  if (typeof r.context === 'object' && r.context !== null) {
    const rc = r.context as Record<string, unknown>;
    if (Array.isArray(rc.ladder)) {
      const rungs = rc.ladder.filter((x): x is number => typeof x === 'number');
      // Left un-normalized here; context-policy.setLadder() clamps and orders
      // it, so one validator owns the invariants rather than two.
      if (rungs.length > 0) out.context = { ...out.context, ladder: rungs };
    }
    if (typeof rc.maxTokens === 'number' && Number.isFinite(rc.maxTokens)) {
      out.context = { ...out.context, maxTokens: Math.floor(rc.maxTokens as number) };
    }
  }
  if (typeof r.archimedes === 'object' && r.archimedes !== null) {
    const rb = r.archimedes as Record<string, unknown>;
    // Only copy present keys — the CLI spreads this over DEFAULT_ARCHIMEDES_CONFIG,
    // so an explicit `undefined` here would clobber a default.
    const archimedes: NonNullable<ProjectConfig['archimedes']> = {};
    if (rb.enabled === true || rb.enabled === false) archimedes.enabled = rb.enabled;
    if (typeof rb.modelName === 'string') archimedes.modelName = rb.modelName;
    if (rb.backend === 'ollama' || rb.backend === 'lmstudio') archimedes.backend = rb.backend;
    if (typeof rb.ollamaBaseUrl === 'string') archimedes.ollamaBaseUrl = rb.ollamaBaseUrl;
    if (typeof rb.lmstudioBaseUrl === 'string') archimedes.lmstudioBaseUrl = rb.lmstudioBaseUrl;
    if (typeof rb.competenceThreshold === 'number') archimedes.competenceThreshold = rb.competenceThreshold;
    if (typeof rb.minAttempts === 'number' && rb.minAttempts > 0) archimedes.minAttempts = Math.floor(rb.minAttempts);
    if (typeof rb.epsilonProbeRate === 'number' && rb.epsilonProbeRate >= 0 && rb.epsilonProbeRate <= 1) archimedes.epsilonProbeRate = rb.epsilonProbeRate;
    if (typeof rb.verifierModel === 'string' && rb.verifierModel.trim()) archimedes.verifierModel = rb.verifierModel.trim();
    out.archimedes = archimedes;
  }
  if (Array.isArray(r.providers)) {
    out.providers = r.providers
      .filter((p: unknown): p is Record<string, unknown> =>
        typeof p === 'object' && p !== null &&
        typeof (p as Record<string, unknown>).name === 'string' &&
        typeof (p as Record<string, unknown>).baseUrl === 'string' &&
        Array.isArray((p as Record<string, unknown>).prefixes))
      .map((p: Record<string, unknown>) => ({
        name: p.name as string,
        baseUrl: p.baseUrl as string,
        apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : undefined,
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
        prefixes: (p.prefixes as unknown[]).filter((x): x is string => typeof x === 'string'),
        models: Array.isArray(p.models)
          ? (p.models as unknown[])
              .filter((m): m is Record<string, unknown> =>
                typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).id === 'string')
              .map((m: Record<string, unknown>) => ({
                id: m.id as string,
                name: typeof m.name === 'string' ? m.name : undefined,
                speed: typeof m.speed === 'string' ? m.speed : undefined,
              }))
          : undefined,
      }));
  }
  return out;
}

/**
 * CLI flags always win over file config, but file config beats defaults.
 * Order of precedence: explicit args > .aura.json > built-in defaults.
 */
export interface ResolvedConfig {
  /** Model id; undefined when the user hasn't picked one yet (the wizard handles this). */
  model?: string;
  baseUrl?: string;
  /** Reasoning effort; undefined leaves the provider's own default. */
  effort?: EffortLevel;
  mode: 'normal' | 'read-only' | 'auto';
  maxTurns?: number;
  ignore: string[];
  systemPromptSuffix?: string;
  /** Custom providers from .aura.json */
  providers: ProviderDef[];
  rateLimitRpm?: number;
  rateLimitTpm?: number;
  maxRetries?: number;
  fallbacks?: string[];
}

export function resolveConfig(
  file: ProjectConfig,
  cli: {
    model?: string; baseUrl?: string; effort?: EffortLevel;
    auto?: boolean; readonly?: boolean;
    maxTurns?: number; ignore?: string[];
    rateLimitRpm?: number; rateLimitTpm?: number; maxRetries?: number;
    fallbacks?: string[];
  },
  defaults: { model: string; mode: 'normal' | 'read-only' | 'auto'; maxTurns?: number; ignore: string[] },
): ResolvedConfig {
  const mode =
    cli.auto ? 'auto' :
    cli.readonly ? 'read-only' :
    file.mode ?? defaults.mode;

  return {
    model: cli.model ?? file.model ?? defaults.model,
    baseUrl: cli.baseUrl ?? file.baseUrl,
    effort: cli.effort ?? file.effort,
    mode,
    maxTurns: cli.maxTurns ?? file.maxTurns ?? defaults.maxTurns,
    ignore: [...defaults.ignore, ...(file.ignore ?? []), ...(cli.ignore ?? [])],
    systemPromptSuffix: file.systemPromptSuffix,
    providers: file.providers ?? [],
    rateLimitRpm: cli.rateLimitRpm ?? file.rateLimitRpm,
    rateLimitTpm: cli.rateLimitTpm ?? file.rateLimitTpm,
    maxRetries: cli.maxRetries ?? file.maxRetries,
    fallbacks: cli.fallbacks ?? file.fallbacks,
  };
}

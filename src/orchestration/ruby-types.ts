// ─────────────────────────────────────────────────────────────────────────────
// Ruby language / Ruby Diamond project context
// ─────────────────────────────────────────────────────────────────────────────

/** Detected application framework for a Ruby codebase. */
export type RubyFramework = 'rails' | 'sinatra' | 'rack' | 'plain' | 'unknown';

/** Test runner commonly used in Ruby projects. */
export type RubyTestFramework = 'rspec' | 'minitest' | 'test-unit' | 'unknown';

/**
 * Snapshot of Ruby-specific project metadata used by the orchestrator when
 * routing goals and assigning specialists to gem- or Rails-aware work.
 */
export interface RubyProjectContext {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Inferred framework from Gemfile / directory layout. */
  framework: RubyFramework;
  /** Whether a Gemfile exists at the project root. */
  hasGemfile: boolean;
  /** Whether a Gemfile.lock is present (dependency graph is pinned). */
  hasGemfileLock: boolean;
  /** Parsed `.ruby-version` or Gemfile `ruby` directive, if found. */
  rubyVersion?: string;
  /** Detected test framework, if any. */
  testFramework: RubyTestFramework;
  /** Top-level entry files the orchestrator should treat as significant. */
  entrypoints: string[];
  /** Unix timestamp (ms) when this context was captured. */
  capturedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruby Diamond ecosystem bridge
// ─────────────────────────────────────────────────────────────────────────────

/** Identifies which Ruby Diamond surface produced or consumes orchestration data. */
export type RubyDiamondSurface = 'aura-code' | 'ruby-diamond-client' | 'harness' | 'unknown';

/**
 * Cross-surface envelope for passing orchestration payloads between Aura CLI,
 * Ruby Diamond desktop, and Python harness generators.
 */
export interface RubyDiamondEnvelope<T = unknown> {
  /** Schema version for forward-compatible deserialization. */
  version: 1;
  /** Originating or target surface. */
  surface: RubyDiamondSurface;
  /** Logical message kind (e.g. plan_created, step_done). */
  kind: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Typed payload. */
  payload: T;
}
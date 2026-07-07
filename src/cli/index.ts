#!/usr/bin/env node
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import minimist from 'minimist';
import chalk from 'chalk';

import { KNOWN_MODELS, getAllModels, registerCustomProviders, apiKeyEnvVarForModel } from '../providers/factory.js';
import { refreshLiveModels } from '../providers/live-models.js';

void refreshLiveModels().catch(() => {}); // fire-and-forget at module load — see comment history for why this isn't awaited
import { createResilientProvider } from '../providers/resilient-factory.js';
import { loadProjectContext, loadGraphSummary } from '../agent/context.js';
import { generateDashboard, openDashboard } from '../viz/index.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem, setSharedReadline, getSharedReadline } from '../safety/permissions.js';
import { createTerminalDisplay } from './display.js';
import { initTui, startInput, setCallbacks, setChatId, writeOutput, createTuiDisplay, destroyTui } from './tui.js';
import { startServer } from '../server/index.js';
import type { PermissionLevel } from '../safety/permissions.js';
import { loadProjectConfig, resolveConfig } from '../config/project-config.js';
import pkg from '../../package.json';

import { DEFAULTS, FALLBACK_CHAIN } from '../config/defaults.js';
import { sessionStore } from '../agent/session-store.js';
import type { LLMProvider } from '../providers/types.js';
import { loadGlobalConfig, saveGlobalConfig, globalConfigPath } from '../setup/global-config.js';
import { loadKeysIntoEnv, saveKey } from '../setup/key-store.js';
import { needsWizard, hasGlobalConfig, hasAnyEnvKey } from '../setup/first-run.js';
import { runProviderWizard, loadProviderConfig } from '../setup/provider-wizard.js';
import { routeTask, createPlan, executePlan } from '../orchestration/index.js';
import { loadPerception, isStale, extractPerception } from '../perception/index.js';
import { mineWeaknesses, saveReport, reportPath } from '../harness/weakness-miner.js';
import { generateProposals, listProposals, applyHarnessProposal } from '../harness/proposer.js';
import { createWorkflow, runWorkflow, resumeWorkflow, listWorkflows, saveWorkflowState } from '../workflows/engine.js';
import type { WorkflowStep, StepResult } from '../workflows/types.js';
import { createBlueprint, loadBlueprint, listBlueprints as listArchitectBlueprints, markBuilt, addDeviation, updateBlueprintStatus } from '../architect/engine.js';
import type { Blueprint } from '../architect/types.js';
import { renderBanner } from './diamond.js';


// ─────────────────────────────────────────────────────────────────────────────
// Parse args
// ─────────────────────────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string:  ['model', 'm', 'api-key', 'base-url', 'mode', 'cwd', 'rate-limit-rpm', 'rate-limit-tpm', 'max-retries', 'max-verify-retries', 'max-turns', 'fallback', 'resume', 'chat-id', 'profile', 'test-command', 'workflow', 'resume-workflow', 'workflow-name', 'apply-harness', 'blueprint', 'build'],
  boolean: ['help', 'h', 'version', 'v', 'auto', 'readonly', 'models', 'no-session', 'no-setup', 'reset-setup', 'orchestrate', 'plan', 'architect', 'list-sessions', 'new-session', 'verify', 'analyze', 'workflows', 'propose-harness', 'blueprints', 'moa'],
  alias:   { m: 'model', h: 'help', v: 'version' },
  default: {
    model: process.env.AURA_MODEL,
    mode:  'normal',
  },
});

function num(s: unknown): number | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const cliMaxRetries      = num(argv['max-retries']) ?? num(process.env.AURA_MAX_RETRIES);
const cliMaxVerifyRetries = num(argv['max-verify-retries']);
const cliMaxTurns        = num(argv['max-turns']);
const cliVerify          = argv.verify === true;
// Voice output: speak task summaries aloud. Enabled by --speak or AURA_SPEAK=1;
// toggled at runtime in the REPL with :speak. Mutable so :speak can flip it.
let speakEnabled         = argv.speak === true || process.env.AURA_SPEAK === '1';
const cliProfile         = typeof argv.profile === 'string' ? argv.profile : undefined;
const cliTestCommand     = typeof argv['test-command'] === 'string' ? argv['test-command'] : undefined;
const cliRpm             = num(argv['rate-limit-rpm']) ?? num(process.env.AURA_API_RPM);
const cliTpm             = num(argv['rate-limit-tpm']) ?? num(process.env.AURA_API_TPM);
const cliFallbacks: string[] =
  Array.isArray(argv.fallback)
    ? argv.fallback.map(String)
    : typeof argv.fallback === 'string'
      ? [argv.fallback]
      : process.env.AURA_FALLBACK_MODEL
          ? [process.env.AURA_FALLBACK_MODEL]
        : [...FALLBACK_CHAIN];

// ─────────────────────────────────────────────────────────────────────────────
// Help / version
// ─────────────────────────────────────────────────────────────────────────────

if (argv.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  console.log(`Aura v${pkg.version}`);
  process.exit(0);
}

if (argv.models) {
  console.log('\n' + chalk.hex('#cc785c').bold('  Supported models:\n'));
  const allModels = getAllModels();
  const byProvider = allModels.reduce<Record<string, typeof allModels>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});
  for (const [provider, models] of Object.entries(byProvider)) {
    console.log(chalk.hex('#8a7768')(`  ${provider}`));
    for (const m of models) {
      console.log(`    ${chalk.hex('#cc785c')(m.id.padEnd(45))} ${chalk.hex('#4e3d30')(m.speed)}`);
    }
  }
  console.log(chalk.hex('#4e3d30')('\n  Use --model <id> or set AURA_MODEL env var'));
  console.log(chalk.hex('#4e3d30')('  For Ollama: --model ollama/llama3.2'));
  console.log(chalk.hex('#4e3d30')('  For OpenRouter: --model openrouter/<provider>/<name>\n'));
  process.exit(0);
}

if (argv['list-sessions']) {
  const root = argv.cwd ? path.resolve(argv.cwd) : process.cwd();
  const sessions = sessionStore.listSessions(root);
  if (sessions.length === 0) {
    console.log(chalk.hex('#8a7768')('\n  No saved sessions for this project.\n'));
  } else {
    console.log(chalk.hex('#cc785c').bold('\n  Saved sessions:\n'));
    for (const s of sessions) {
      const updated = new Date(s.updatedAt).toLocaleString();
      const turns = Math.floor(s.history.length / 2);
      console.log(
        `  ${chalk.hex('#cc785c')(s.id.padEnd(20))} ` +
        `${chalk.hex('#ede0cc')(s.title.slice(0, 45).padEnd(46))} ` +
        `${chalk.hex('#4e3d30')(`${turns}t · ${updated}`)}`,
      );
    }
    console.log();
  }
  process.exit(0);
}

if (argv.analyze) {
  const report = mineWeaknesses();
  const outPath = saveReport(report);
  console.log(chalk.hex('#cc785c').bold('\n  Weakness Analysis Report\n'));
  console.log(chalk.hex('#8a7768')(`  Sessions analyzed: ${report.sessionsAnalyzed}`));
  console.log(chalk.hex('#8a7768')(`  Report saved to: ${outPath}\n`));

  if (report.patterns.length === 0) {
    console.log(chalk.hex('#5a9e6e')('  ✓ No recurring weakness patterns detected. Agent behavior looks healthy.\n'));
  } else {
    for (const p of report.patterns) {
      console.log(chalk.hex('#b15439').bold(`  ✗ ${p.pattern} (${p.frequency} occurrences)`));
      console.log(chalk.hex('#8a7768')(`    ${p.description}`));
      if (p.occurrences[0]) {
        console.log(chalk.hex('#4e3d30')(`    Example task: "${p.occurrences[0].exampleTask.slice(0, 80)}"`));
        console.log(chalk.hex('#4e3d30')(`    Example failure: ${p.occurrences[0].exampleFailure.slice(0, 100)}`));
      }
      console.log(chalk.hex('#cc785c')(`    Suggestion: ${p.promptPatch.slice(0, 120)}...`));
      console.log();
    }
    console.log(chalk.hex('#8a7768')(`  ${report.summary}\n`));
  }
  process.exit(0);
}

if (argv['propose-harness']) {
  // Ensure a weakness report exists — mine if needed
  if (!fs.existsSync(reportPath())) {
    console.log(chalk.hex('#8a7768')('\n  No weakness report found — mining sessions first...\n'));
    const report = mineWeaknesses();
    saveReport(report);
  }

  const proposals = generateProposals();
  if (proposals.length === 0) {
    console.log(chalk.hex('#5a9e6e')('\n  ✓ No proposals generated — no actionable weakness patterns found.\n'));
  } else {
    console.log(chalk.hex('#cc785c').bold('\n  Harness Proposals\n'));
    for (const p of proposals) {
      console.log(chalk.hex('#cc785c')(`  ${p.id}`));
      console.log(chalk.hex('#8a7768')(`    Pattern:  ${p.pattern} (${p.description.slice(0, 60)})`));
      console.log(chalk.hex('#8a7768')(`    Section:  ${p.targetSection}`));
      console.log(chalk.hex('#4e3d30')(`    Patch:    ${p.patchText.slice(0, 80)}...`));
      console.log();
    }
    console.log(chalk.hex('#5a9e6e')(`  ${proposals.length} proposal(s) saved to ~/.aura/harness/proposals/`));
    console.log(chalk.hex('#8a7768')('  Apply with: ruby --apply-harness <id>\n'));
  }
  process.exit(0);
}

if (typeof argv['apply-harness'] === 'string' && argv['apply-harness']) {
  const proposalId = argv['apply-harness'];
  console.log(chalk.hex('#cc785c').bold(`\n  Applying harness proposal: ${proposalId}\n`));

  const result = applyHarnessProposal(proposalId);
  if (result.success) {
    console.log(chalk.hex('#5a9e6e')(`  ✓ ${result.message}\n`));
  } else {
    console.log(chalk.hex('#b15439')(`  ✗ ${result.message}\n`));
  }
  process.exit(result.success ? 0 : 1);
}

// ── --workflows: list all persisted workflows ────────────────────────────────
if (argv.workflows) {
  (async () => {
    const workflows = await listWorkflows();
    if (workflows.length === 0) {
      console.log(chalk.hex('#8a7768')('\n  No saved workflows.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold('\n  Saved workflows:\n'));
      for (const ws of workflows) {
        const created = new Date(ws.definition.createdAt).toLocaleString();
        const doneSteps = ws.stepStates.filter(s => s.status === 'done').length;
        const totalSteps = ws.definition.steps.length;
        const statusColor = ws.status === 'done' ? '#5a9e6e' : ws.status === 'failed' ? '#b15439' : '#cc785c';
        console.log(
          `  ${chalk.hex('#cc785c')(ws.definition.id.padEnd(24))} ` +
          `${chalk.hex('#ede0cc')(ws.definition.name.slice(0, 36).padEnd(37))} ` +
          `${chalk.hex(statusColor)(ws.status.padEnd(8))} ` +
          `${chalk.hex('#4e3d30')(`${doneSteps}/${totalSteps} steps · ${created}`)}`,
        );
      }
      console.log();
    }
    process.exit(0);
  })();
}

// ── --blueprints: list all saved blueprints ──────────────────────────────────
if (argv.blueprints) {
  (async () => {
    const bps = await listArchitectBlueprints();
    if (bps.length === 0) {
      console.log(chalk.hex('#8a7768')('\n  No saved blueprints.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold('\n  Saved blueprints:\n'));
      for (const bp of bps) {
        const created = new Date(bp.createdAt).toLocaleString();
        const builtCount = bp.files.filter(f => f.status === 'built').length;
        const totalFiles = bp.files.length;
        const statusColor = bp.status === 'complete' ? '#5a9e6e' : bp.status === 'building' ? '#cc9e5c' : '#cc785c';
        console.log(
          `  ${chalk.hex(statusColor)(bp.status.padEnd(10))} ` +
          `${chalk.hex('#cc785c')(bp.id.slice(0, 16).padEnd(18))} ` +
          `${chalk.hex('#ede0cc')(bp.task.slice(0, 40).padEnd(41))} ` +
          `${chalk.hex('#4e3d30')(`${builtCount}/${totalFiles} files · ${created}`)}`,
        );
      }
      console.log();
    }
    process.exit(0);
  })();
}

// ── --blueprint <id>: show a saved blueprint ────────────────────────────────
if (typeof argv.blueprint === 'string' && argv.blueprint) {
  (async () => {
    const bp = await loadBlueprint(argv.blueprint);
    if (!bp) {
      console.error(chalk.hex('#b15439')(`\n  ✗ Blueprint not found: ${argv.blueprint}\n`));
      process.exit(1);
    }

    const statusColor = bp.status === 'complete' ? '#5a9e6e' : bp.status === 'building' ? '#cc9e5c' : '#cc785c';
    console.log(chalk.hex('#cc785c').bold('\n  Blueprint\n'));
    console.log(`  ${chalk.hex('#8a7768')('ID:')}      ${chalk.hex('#cc785c')(bp.id)}`);
    console.log(`  ${chalk.hex('#8a7768')('Task:')}    ${chalk.hex('#ede0cc')(bp.task)}`);
    console.log(`  ${chalk.hex('#8a7768')('Status:')}  ${chalk.hex(statusColor)(bp.status)}`);
    console.log(`  ${chalk.hex('#8a7768')('Steps:')}   ${bp.estimatedSteps}`);
    console.log(`  ${chalk.hex('#8a7768')('Created:')} ${new Date(bp.createdAt).toLocaleString()}`);
    if (bp.builtAt) console.log(`  ${chalk.hex('#8a7768')('Built:')}   ${new Date(bp.builtAt).toLocaleString()}`);

    if (bp.files.length > 0) {
      console.log(chalk.hex('#cc785c').bold('\n  Files:\n'));
      for (const f of bp.files) {
        const fileStatusColor = f.status === 'built' ? '#5a9e6e' : f.status === 'skipped' ? '#8a7768' : '#cc785c';
        console.log(
          `    ${chalk.hex(fileStatusColor)(f.status.padEnd(8))} ${chalk.hex('#cc785c')(f.path)}`,
        );
        console.log(`            ${chalk.hex('#8a7768')(f.purpose)}`);
        if (f.exports.length > 0) {
          console.log(`            ${chalk.hex('#4e3d30')(`exports: ${f.exports.join(', ')}`)}`);
        }
        if (f.interfaces.length > 0) {
          console.log(`            ${chalk.hex('#4e3d30')(`interfaces: ${f.interfaces.join(', ')}`)}`);
        }
      }
    }

    if (bp.dataModels.length > 0) {
      console.log(chalk.hex('#cc785c').bold('\n  Data Models:\n'));
      for (const dm of bp.dataModels) {
        console.log(`    ${chalk.hex('#cc785c')(dm.name)} — ${chalk.hex('#8a7768')(dm.description)}`);
        for (const field of dm.fields) {
          console.log(`      ${chalk.hex('#4e3d30')(field)}`);
        }
      }
    }

    if (bp.dependencies.length > 0) {
      console.log(chalk.hex('#cc785c').bold('\n  Dependencies:\n'));
      for (const dep of bp.dependencies) {
        console.log(`    ${chalk.hex('#4e3d30')(dep)}`);
      }
    }

    if (bp.risks.length > 0) {
      console.log(chalk.hex('#b15439').bold('\n  Risks:\n'));
      for (const risk of bp.risks) {
        console.log(`    ${chalk.hex('#b15439')('⚠')} ${chalk.hex('#8a7768')(risk)}`);
      }
    }

    if (bp.deviations.length > 0) {
      console.log(chalk.hex('#cc9e5c').bold('\n  Deviations:\n'));
      for (const dev of bp.deviations) {
        const time = new Date(dev.recordedAt).toLocaleString();
        console.log(`    ${chalk.hex('#cc9e5c')('→')} ${chalk.hex('#8a7768')(dev.description)} ${chalk.hex('#4e3d30')(`(${time})`)}`);
      }
    }

    console.log();
    process.exit(0);
  })();
}

if (argv.help) {
  printHelp();
  process.exit(0);
}
// When run with no args and nothing in stdin, show help then exit.
// When run with no args + a TTY or piped input, fall through to the REPL/wizard.
// Skip this gate when --reset-setup is set (the wizard should fire even if env
// vars make needsWizard() return false).
if (argv._.length === 0 && !argv.interactive && process.stdin.isTTY !== true && !argv['reset-setup']) {
  if (!needsWizard({})) {
    printHelp();
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve config — CLI > .aura.json > global config > first-run wizard
// ─────────────────────────────────────────────────────────────────────────────

const cwd = argv.cwd ? path.resolve(argv.cwd) : process.cwd();
const fileConfig = loadProjectConfig(cwd);

// Load persisted API keys (~/.aura/keys.json) into process.env before any
// provider is built — so keys set once with :apikey survive across sessions
// and every provider sees them, without depending on shell rc files. Real
// environment values are never overridden.
loadKeysIntoEnv();

// Pull global config (saved by the setup wizard) so the user doesn't have
// to re-set their provider on every run. provider.json is the fuller record
// from the same wizard save — it also carries the API key and base URL, so a
// choice made last session works next session without any env vars.
const globalCfg = loadGlobalConfig();
const savedProvider = loadProviderConfig();

// Effective model = CLI > AURA_MODEL env > .aura.json > global config > undefined
const cliModel = typeof argv.model === 'string' ? argv.model : undefined;
const effectiveModel = cliModel ?? fileConfig.model ?? globalCfg?.defaultModel
  ?? savedProvider?.model ?? process.env.AURA_MODEL;

// The saved provider record only applies when we're actually running the
// model it was saved with — its baseUrl/apiKey belong to that provider.
const savedProviderApplies = !!savedProvider && effectiveModel === savedProvider.model;

// Effective base URL = CLI > .aura.json > global config > undefined.
// CRITICAL: the global config's baseUrl belongs to the provider the wizard
// configured — it must NOT be forced onto a DIFFERENT model. Otherwise picking
// `-m deepseek/...` while the global default is a GLM/Z.ai endpoint sends the
// DeepSeek key to Z.ai → 401. So only inherit globalCfg.baseUrl when the
// effective model is actually that global default model (same provider).
const cliBaseUrl = typeof argv['base-url'] === 'string' ? argv['base-url'] : undefined;
const globalBaseUrlApplies =
  !!globalCfg?.baseUrl &&
  !!globalCfg?.defaultModel &&
  effectiveModel === globalCfg.defaultModel;
const effectiveBaseUrl =
  cliBaseUrl ?? fileConfig.baseUrl
    ?? (globalBaseUrlApplies ? globalCfg!.baseUrl : undefined)
    ?? (savedProviderApplies ? savedProvider!.baseUrl : undefined);

const resolved = resolveConfig(
  { ...fileConfig, model: effectiveModel, baseUrl: effectiveBaseUrl },
  {
    model: cliModel,
    baseUrl: cliBaseUrl,
    auto: argv.auto === true,
    readonly: argv.readonly === true,
    maxTurns: cliMaxTurns,
    rateLimitRpm: cliRpm,
    rateLimitTpm: cliTpm,
    maxRetries: cliMaxRetries,
    fallbacks: cliFallbacks.length > 0 ? cliFallbacks : undefined,
  },
  { model: undefined as unknown as string, mode: 'normal', ignore: [] },
);

// Register custom providers from .aura.json
registerCustomProviders(resolved.providers);

const permissionLevel: PermissionLevel = resolved.mode;

// Mutable runtime state — :model command updates this
const runtimeConfig = {
  model: resolved.model,
  baseUrl: resolved.baseUrl,
  // --api-key wins; otherwise the key the wizard saved with this model last
  // session. Env vars only apply when neither is present (factory fallback).
  apiKey: typeof argv['api-key'] === 'string'
    ? argv['api-key']
    : (savedProviderApplies ? savedProvider!.apiKey : undefined),
};

// ── Profile: local → Ollama defaults ─────────────────────────────────────────
if (cliProfile === 'local') {
  resolved.baseUrl = 'http://localhost:11434/v1';
  if (!runtimeConfig.apiKey) {
    runtimeConfig.apiKey = 'ollama';
  }
}

function buildProvider(display: ReturnType<typeof createTerminalDisplay>): LLMProvider {
  // Caller guarantees resolved.model is set (guarded in main()).
  const model = resolved.model!;
  return createResilientProvider(
    {
      model,
      apiKey:  runtimeConfig.apiKey,
      baseUrl: runtimeConfig.baseUrl ?? undefined,
    },
    {
      rpm: resolved.rateLimitRpm,
      tpm: resolved.rateLimitTpm,
      maxRetries: resolved.maxRetries,
      fallbacks: resolved.fallbacks,
    },
    display,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const display = createTerminalDisplay();

  // ── First-run wizard ───────────────────────────────────────────────────────
  // Skip if: --no-setup flag, --api-key on CLI, env var set, or global config exists.
  // Non-interactive modes (one-shot, --models, --help) skip the wizard too.
  // Wizard only fires when we're in an interactive terminal (TTY + no other args).
  // Wizard is eligible when there are no other args (no one-shot task) AND
  // we're not in a strict TTY-less script context. Accept both TTY and pipe:
  //   - TTY = real interactive use
  //   - pipe = test harnesses (and `aura | tee log`)
  // The one-shot path (`aura "task"`) has argv._.length > 0 so the
  // wizard can't fire there. --reset-setup alone is treated as interactive
  // since the whole point is to launch the wizard.
  const isInteractive = argv.interactive === true
    || process.argv.slice(2).length === 0
    || argv['reset-setup'] === true;
  const cliApiKey = typeof argv['api-key'] === 'string' ? argv['api-key'] : undefined;
  const cliModel = typeof argv.model === 'string' ? argv.model : undefined;
  const skipSetup = argv['no-setup'] === true || argv.help === true || argv.h === true || argv.models === true || argv.version === true || argv.v === true;
  const resetSetup = argv['reset-setup'] === true;
  if (resetSetup) {
    // Wipe both saved configs so the wizard fires unconditionally and no
    // stale provider record (baseUrl/apiKey) survives the reset.
    try { fs.unlinkSync(globalConfigPath()); } catch { /* not present */ }
    try { fs.unlinkSync(path.join(path.dirname(globalConfigPath()), 'provider.json')); } catch { /* not present */ }
  }
  // When --reset-setup is set, force the wizard to fire (overrides env-var
  // detection — the user explicitly wants to reconfigure).
  const shouldRunWizard = !skipSetup && isInteractive && (
    resetSetup || needsWizard({ cliApiKey, cliModel })
  );
  if (shouldRunWizard) {
    // If stdin is not a TTY and there's nothing piped in, the wizard will
    // hang. Skip with a helpful message instead.
    if (process.stdin.isTTY !== true && !process.stdin.readable) {
      console.error(chalk.hex('#b15439')('\n  ✗ No interactive input available.'));
      console.error(chalk.hex('#8a7768')('  Set an API key env var (e.g. export OPENAI_API_KEY=...)'));
      console.error(chalk.hex('#8a7768')('  or pass --api-key <key> --model <id> on the command line,\n'));
      process.exit(1);
    }
    // Full provider wizard: pick provider + model, detect/enter key, and
    // TEST the connection (URL normalization + response validation) before
    // saving. The choice is persisted and restored on every later run.
    const cfg = await runProviderWizard();
    if (!cfg) {
      console.error(chalk.hex('#b15439')('\n  ✗ Setup cancelled. Set an API key env var (e.g. export OPENAI_API_KEY=...) or run with --api-key.\n'));
      process.exit(1);
    }
    // Apply the wizard's choice to this session (it already saved to disk).
    resolved.model = cfg.model;
    resolved.baseUrl = cfg.baseUrl || undefined;
    runtimeConfig.model = cfg.model;
    runtimeConfig.baseUrl = cfg.baseUrl || undefined;
    if (cfg.apiKey) runtimeConfig.apiKey = cfg.apiKey;
  }

  let ctx: Awaited<ReturnType<typeof loadProjectContext>>;
  try {
    ctx = await loadProjectContext(cwd);
  } catch (e) {
    display.error(`Could not load project context: ${String(e)}`);
    process.exit(1);
  }

  // ── Guard: we need a model before we can build a provider ─────────────────
  if (!resolved.model) {
    console.error(chalk.hex('#b15439')('\n  ✗ No model configured.'));
    console.error(chalk.hex('#8a7768')('  Run `aura` with no args in a TTY to launch the setup wizard,'));
    console.error(chalk.hex('#8a7768')('  or pass --model <id> --api-key <key> on the command line,'));
    console.error(chalk.hex('#8a7768')('  or set the model in .aura.json (`"model": "..."`).'));
    process.exit(1);
  }

  let provider;
  try {
    provider = buildProvider(display);
  } catch (e) {
    display.error(`Could not initialize provider: ${String(e)}`);
    process.exit(1);
  }

  const permissions = new PermissionSystem(permissionLevel);

  // ── Session / chat-ID resolution ───────────────────────────────────────────
  const noSession = argv['no-session'] === true;
  const projectRoot = ctx.root || cwd;

  // Active session state (mutable — commands can swap it)
  let activeChatId: string | undefined;
  let activeChatHistory: import('../providers/types.js').HistoryMessage[] = [];
  let activeChatTitle: string | undefined;

  if (!noSession) {
    if (argv['new-session']) {
      // Force a brand-new session
      activeChatId = sessionStore.generateId();
    } else if (typeof argv['resume'] === 'string' && argv['resume']) {
      // --resume <id>
      const loaded = await sessionStore.loadSession(projectRoot, argv['resume']);
      if (!loaded) {
        console.error(chalk.hex('#b15439')(`\n  ✗ Session not found: ${argv['resume']}\n`));
        process.exit(1);
      }
      activeChatId = loaded.id;
      activeChatHistory = loaded.history;
      activeChatTitle = loaded.title;
      console.log(chalk.hex('#5a9e6e')(`\n  ↩ Resuming session ${loaded.id} — "${loaded.title}" (${Math.floor(loaded.history.length / 2)} turns)\n`));
    } else if (argv['resume'] === true || argv['resume'] === '') {
      // --resume with no value → resume latest
      const latest = sessionStore.findLatestSession(projectRoot);
      if (latest) {
        activeChatId = latest.id;
        activeChatHistory = latest.history;
        activeChatTitle = latest.title;
        console.log(chalk.hex('#5a9e6e')(`\n  ↩ Resuming latest session ${latest.id} — "${latest.title}" (${Math.floor(latest.history.length / 2)} turns)\n`));
      } else {
        activeChatId = sessionStore.generateId();
      }
    } else if (typeof argv['chat-id'] === 'string' && argv['chat-id']) {
      activeChatId = argv['chat-id'];
      const existing = await sessionStore.loadSession(projectRoot, activeChatId);
      if (existing) {
        activeChatHistory = existing.history;
        activeChatTitle = existing.title;
      }
    } else {
      activeChatId = sessionStore.generateId();
    }
  }

  // Legacy sessionPath kept for single-task one-shot mode
  const sessionPath = noSession ? undefined : path.join(sessionStore.defaultDir(),
    projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80), 'latest.json');

  // ── Startup banner ──────────────────────────────────────────────────────────
  renderBanner({
    version: pkg.version,
    title: ctx.name,
    provider: provider.name,
    model: runtimeConfig.model,
    language: ctx.language,
    mode: permissionLevel,
    cwd: projectRoot,
    extras: [
      ...(fileConfig.model ? ['.aura.json loaded'] : []),
      ...(activeChatId ? [`chat ${activeChatId}`] : []),
    ],
  });

  const cumulative = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  // ── --build <id>: build from a saved blueprint in dependency order ───────────
  if (typeof argv.build === 'string' && argv.build) {
    const bp = await loadBlueprint(argv.build);
    if (!bp) {
      console.error(chalk.hex('#b15439')(`\n  ✗ Blueprint not found: ${argv.build}\n`));
      process.exit(1);
    }

    display.header('Architect Builder', `Building from blueprint: ${bp.id}`);
    console.log(chalk.hex('#8a7768')(`  Task: ${bp.task}`));
    console.log(chalk.hex('#8a7768')(`  Files: ${bp.files.filter(f => f.status === 'planned').length} to build\n`));

    await updateBlueprintStatus(bp.id, 'building');

    // Build files in order — planned files only
    const plannedFiles = bp.files.filter(f => f.status === 'planned');

    for (const file of plannedFiles) {
      console.log(chalk.hex('#cc785c')(`  ▸ Building: ${file.path} — ${file.purpose}`));

      const buildTask = [
        `Create the file ${file.path}.`,
        `Purpose: ${file.purpose}`,
        file.exports.length > 0 ? `Exports: ${file.exports.join(', ')}` : '',
        file.interfaces.length > 0 ? `Interfaces: ${file.interfaces.join(', ')}` : '',
        `This file is part of a larger blueprint for: ${bp.task}`,
        bp.dependencies.length > 0 ? `Dependencies: ${bp.dependencies.join(', ')}` : '',
        'Follow the existing code style. Do not modify other files.',
      ].filter(Boolean).join('\n');

      try {
        const result = await runAgentLoop({
          provider, task: buildTask, context: ctx, permissions, display,
          initialHistory: [],
          maxTurns: Math.min(resolved.maxTurns ?? 50, 50),
          spawnConfig: {
            apiKey: runtimeConfig.apiKey,
            baseUrl: runtimeConfig.baseUrl ?? undefined,
          },
        });

        if (result.success) {
          await markBuilt(bp.id, file.path);
          console.log(chalk.hex('#5a9e6e')(`  ✓ ${file.path} built\n`));
        } else {
          console.log(chalk.hex('#b15439')(`  ✗ ${file.path} failed: ${result.summary}\n`));
          await addDeviation(bp.id, `Failed to build ${file.path}: ${result.summary}`);
        }
      } catch (e) {
        console.log(chalk.hex('#b15439')(`  ✗ ${file.path} error: ${String(e)}\n`));
        await addDeviation(bp.id, `Error building ${file.path}: ${String(e)}`);
      }
    }

    // Final status
    const finalBp = await loadBlueprint(bp.id);
    if (finalBp) {
      const allBuilt = finalBp.files.every(f => f.status !== 'planned');
      if (allBuilt) {
        await updateBlueprintStatus(bp.id, 'complete');
        console.log(chalk.hex('#5a9e6e').bold(`\n  ✓ Blueprint complete: ${finalBp.files.filter(f => f.status === 'built').length} files built\n`));
      } else {
        console.log(chalk.hex('#cc9e5c').bold(`\n  ⚠ Blueprint partially complete: ${finalBp.files.filter(f => f.status === 'built').length}/${finalBp.files.length} files built\n`));
      }
    }

    return;
  }

  // ── --workflow: create and run a new workflow ──────────────────────────────
  if (typeof argv.workflow === 'string' && argv.workflow) {
    const workflowName = argv.workflow;
    const stepTasks = argv._.map(String);
    if (stepTasks.length === 0) {
      console.error(chalk.hex('#b15439')('\n  ✗ No step tasks provided.'));
      console.error(chalk.hex('#8a7768')('  Usage: ruby --workflow <name> "step 1" "step 2" ...\n'));
      process.exit(1);
    }

    const steps: WorkflowStep[] = stepTasks.map((task: string, i: number) => ({
      name: `step-${i + 1}`,
      task,
    }));

    display.header('Workflow', `Creating workflow "${workflowName}" with ${steps.length} steps`);

    const state = await createWorkflow({ name: workflowName, steps });
    console.log(chalk.hex('#5a9e6e')(`\n  ✓ Workflow created: ${state.definition.id}\n`));

    const makeRunStep = () => {
      return async (task: string, stepIndex: number): Promise<StepResult> => {
        console.log(chalk.hex('#cc785c')(`\n  ▸ Step ${stepIndex + 1}/${steps.length}: ${task}\n`));

        const currentProvider = buildProvider(display);
        const result = await runAgentLoop({
          provider: currentProvider, task, context: ctx, permissions, display,
          initialHistory: [],
          maxTurns: resolved.maxTurns,
          spawnConfig: {
            apiKey: runtimeConfig.apiKey,
            baseUrl: runtimeConfig.baseUrl ?? undefined,
          },
        });

        return {
          success: result.success,
          summary: result.summary,
          turns: result.turns,
          toolCallCount: result.toolCallCount,
          tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
        };
      };
    };

    const finalState = await runWorkflow(state, makeRunStep());

    if (finalState.status === 'done') {
      console.log(chalk.hex('#5a9e6e').bold(`\n  ✓ ${finalState.outcome}\n`));
    } else {
      console.error(chalk.hex('#b15439').bold(`\n  ✗ ${finalState.outcome}\n`));
    }

    const totalTokens = finalState.totalTokens ?? 0;
    console.log(chalk.hex('#4e3d30')(
      `  ↳ ${totalTokens.toLocaleString()} tokens · ${finalState.stepStates.length} steps · status: ${finalState.status}`,
    ));
    if (finalState.status === 'failed') {
      console.log(chalk.hex('#8a7768')(`\n  Resume with: ruby --resume-workflow ${finalState.definition.id}\n`));
      process.exit(1);
    }
    return;
  }

  // ── --resume-workflow <id>: resume a persisted workflow ─────────────────────
  if (typeof argv['resume-workflow'] === 'string' && argv['resume-workflow']) {
    const workflowId = argv['resume-workflow'];

    display.header('Workflow', `Resuming workflow ${workflowId}`);

    const makeRunStep = () => {
      return async (task: string, stepIndex: number): Promise<StepResult> => {
        console.log(chalk.hex('#cc785c')(`\n  ▸ Step ${stepIndex + 1}: ${task}\n`));

        const currentProvider = buildProvider(display);
        const result = await runAgentLoop({
          provider: currentProvider, task, context: ctx, permissions, display,
          initialHistory: [],
          maxTurns: resolved.maxTurns,
          spawnConfig: {
            apiKey: runtimeConfig.apiKey,
            baseUrl: runtimeConfig.baseUrl ?? undefined,
          },
        });

        return {
          success: result.success,
          summary: result.summary,
          turns: result.turns,
          toolCallCount: result.toolCallCount,
          tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
        };
      };
    };

    const finalState = await resumeWorkflow(workflowId, makeRunStep());
    if (!finalState) {
      console.error(chalk.hex('#b15439')(`\n  ✗ Workflow not found: ${workflowId}\n`));
      process.exit(1);
    }

    if (finalState.status === 'done') {
      console.log(chalk.hex('#5a9e6e').bold(`\n  ✓ ${finalState.outcome}\n`));
    } else {
      console.error(chalk.hex('#b15439').bold(`\n  ✗ ${finalState.outcome}\n`));
    }

    const totalTokens = finalState.totalTokens ?? 0;
    console.log(chalk.hex('#4e3d30')(
      `  ↳ ${totalTokens.toLocaleString()} tokens · ${finalState.stepStates.length} steps · status: ${finalState.status}`,
    ));
    if (finalState.status === 'failed') {
      console.log(chalk.hex('#8a7768')(`\n  Resume with: ruby --resume-workflow ${finalState.definition.id}\n`));
      process.exit(1);
    }
    return;
  }

  // ── Single task mode: aura "fix the bug" ──────────────────────────────────────
  if (argv._.length > 0) {
    const task = argv._.join(' ');
    console.log(chalk.hex('#8a7768')(`\n  Task: ${chalk.hex('#ede0cc')(task)}\n`));

    // --architect: plan-only — decompose and display, then exit (no execution)
    if (argv.architect === true) {
      await runArchitectPlan(task, provider, ctx, display);
      return;
    }

    // --build: full orchestrated build — decompose + execute all specialists
    // When --build <id> is a string, build from a saved blueprint instead
    const doOrchestrate = argv.orchestrate === true || argv.build === true;

    if (doOrchestrate) {
      await runOrchestratedTask(task, provider, ctx, display, doOrchestrate);
      return;
    }

    try {
      let perception = await loadPerception(ctx.root);
      if (!perception || isStale(perception)) {
        display.agentThinking();
        perception = await extractPerception(ctx.root);
      }

      const decision = await routeTask({ provider, context: ctx, task, perception: perception ?? undefined });
      if (decision.shouldDecompose && decision.confidence > 0.8) {
        await runOrchestratedTask(task, provider, ctx, display, false, perception ?? undefined);
        return;
      }
    } catch {
      // Router failed — fall through to single agent
    }

    const doVerify = cliVerify || !!fileConfig.verify;

    // --moa: mixture-of-agents Phase 2 — only pays off for exploratory-shaped
    // tasks (see docs/MIXTURE_OF_AGENTS.md), so it's gated on both the flag
    // and the task shape. Other shapes fall through to the single-agent path.
    if (argv.moa === true) {
      const { classifyTask } = await import('../agent/loop-profile.js');
      if (classifyTask(task) === 'exploratory') {
        const { runMixtureOfAgents } = await import('../agent/mixture.js');
        const moaResult = await runMixtureOfAgents({ provider, task, context: ctx, display });
        if (activeChatId && !noSession) {
          await sessionStore.upsertSession(projectRoot, activeChatId, moaResult.history, activeChatTitle);
        }
        if (moaResult.success) {
          display.summary(moaResult.summary, moaResult.turns, moaResult.toolCallCount);
          printUsageFooter(display, moaResult.usage, moaResult.costUsd);
        } else {
          display.error(moaResult.summary);
          process.exit(1);
        }
        return;
      }
      display.warning('--moa only applies to exploratory tasks (explain/analyze/investigate…) — running the normal single-agent path.');
    }

    let result;
    if (doVerify) {
      const { runWithVerification } = await import('../verify/index.js');
      const maxRetries = cliMaxVerifyRetries ?? fileConfig.maxVerifyRetries ?? DEFAULTS.maxVerifyRetries;
      const testCommand = cliTestCommand ?? fileConfig.testCommand;
      const wrapperResult = await runWithVerification({
        loopOpts: {
          provider, task, context: ctx, permissions, display,
          initialHistory: activeChatHistory,
          maxTurns: resolved.maxTurns,
          spawnConfig: {
            apiKey: argv['api-key'] ?? undefined,
            baseUrl: resolved.baseUrl ?? undefined,
          },
          sessionPath,
        },
        config: { enabled: true, maxRetries, testCommand },
        projectRoot: ctx.root,
        display,
      });
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

    if (activeChatId && !noSession) {
      await sessionStore.upsertSession(projectRoot, activeChatId, result.history, activeChatTitle);
    }
    {
      const { recordEpisode } = await import('../dream/episode.js');
      recordEpisode(ctx.root, {
        task,
        model: provider.model,
        success: result.success,
        tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        durationMs: 0,
      });
    }

    if (result.success) {
      display.summary(result.summary, result.turns, result.toolCallCount);
      printUsageFooter(display, result.usage, result.costUsd);
      if (speakEnabled) await speakSummary(result.summary);
    } else {
      display.error(result.summary);
      process.exit(1);
    }
    return;
  }

  // ── Interactive REPL mode (TUI — fixed bottom input) ────────────────────────
  if (activeChatHistory.length > 0) {
    writeOutput(chalk.hex('#8a7768')('  Continuing session with ' + Math.floor(activeChatHistory.length / 2) + ' prior turns.'));
  }

  // Use the TUI display for output
  
  const tuiDisplay = createTuiDisplay();
  initTui();
  if (activeChatId) setChatId(activeChatId);
  startInput();

  // Buffer for :btw and :stop typed during the agent loop
  let pendingBtw: string | null = null;
let abortController: AbortController | null = null;

  setCallbacks({
    onEnter(line: string) {
      processLine(line);
    },
    onStop() {
      if (abortController) abortController?.abort();
    },
  });

  let tuiInputHistory = [];

  async function processLine(input: string) {
    const replCtx = {
      rl: null,
      ctx, display: tuiDisplay,
      providerConfig: { model: resolved.model!, apiKey: runtimeConfig.apiKey, baseUrl: runtimeConfig.baseUrl ?? undefined },
      permissions, cumulative,
      chatState: { projectRoot, activeChatId, activeChatHistory, activeChatTitle, noSession },
      sessionPath,
    };

    // Check for REPL commands
    const cmdResult = await handleReplCommand(input, replCtx);
    if (cmdResult.handled) {
      if (cmdResult.newChatId !== undefined) activeChatId = cmdResult.newChatId;
      if (cmdResult.newHistory !== undefined) activeChatHistory = cmdResult.newHistory;
      if (cmdResult.newTitle !== undefined) activeChatTitle = cmdResult.newTitle;
      if (activeChatId) setChatId(activeChatId);
      return;
    }

    // Run task
    let result;
    abortController = new AbortController();
    const abortSignal = abortController.signal;
    try {
      const currentProvider = buildProvider(tuiDisplay);
      pendingBtw = null;

      const doVerify = argv.verify === true || !!fileConfig.verify;
      if (doVerify) {
        const { runWithVerification } = await import('../verify/index.js');
        const maxRetries = cliMaxVerifyRetries ?? fileConfig.maxVerifyRetries ?? DEFAULTS.maxVerifyRetries;
        const testCommand = cliTestCommand ?? fileConfig.testCommand;
        const wrapperResult = await runWithVerification({
          loopOpts: {
            provider: currentProvider, task: input,
            context: ctx, permissions, display: tuiDisplay,
            initialHistory: activeChatHistory,
            maxTurns: resolved.maxTurns,
            abortSignal,
            spawnConfig: {
              apiKey: runtimeConfig.apiKey,
              baseUrl: runtimeConfig.baseUrl ?? undefined,
            },
            sessionPath,
          },
          config: { enabled: true, maxRetries, testCommand },
          projectRoot: ctx.root,
          display: tuiDisplay,
        });
        result = wrapperResult.loopResult;
      } else {
        result = await runAgentLoop({
          provider: currentProvider, task: input,
          context: ctx, permissions, display: tuiDisplay,
          initialHistory: activeChatHistory,
          maxTurns: resolved.maxTurns,
          spawnConfig: {
            apiKey: runtimeConfig.apiKey,
            baseUrl: runtimeConfig.baseUrl ?? undefined,
          },
          sessionPath,
          abortSignal,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? (err.stack || err.message) : String(err);
      writeOutput(chalk.hex('#b15439')('  ✗ Unhandled error: ' + msg));

      return;
    }

    // Check if task was cancelled by user
    if (abortController?.signal.aborted && !result.success) {
      writeOutput(chalk.hex('#d4903a')('  ⏹ Task cancelled.'));
      // Don't record episode for cancelled tasks
      return;
    }

    // Update stay-active history
    activeChatHistory = result.history;

    // Persist session
    if (activeChatId && !noSession) {
      await sessionStore.upsertSession(projectRoot, activeChatId, activeChatHistory, activeChatTitle);
    }

    {
      const { recordEpisode } = await import('../dream/episode.js');
      recordEpisode(ctx.root, {
        task: input,
        model: runtimeConfig.model ?? resolved.model ?? 'unknown',
        success: result.success,
        tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        durationMs: 0,
      });
    }

    cumulative.turns += result.turns;
    cumulative.toolCalls += result.toolCallCount;
    cumulative.inputTokens += result.usage.inputTokens;
    cumulative.outputTokens += result.usage.outputTokens;
    cumulative.costUsd += result.costUsd;

    if (result.success) {
      tuiDisplay.summary(result.summary, result.turns, result.toolCallCount);
      printUsageFooter(tuiDisplay, result.usage, result.costUsd);
      if (speakEnabled) await speakSummary(result.summary);
    } else {
      tuiDisplay.error(result.summary);
    }

    // Process any :btw that was typed during the loop
    if (pendingBtw) {
      const q = pendingBtw;
      pendingBtw = null;
      abortController = new AbortController();
      const { runBtwQuery, renderBtwAnswer } = await import('../repl/side-channel.js');
      writeOutput(chalk.hex('#4e3d30')('  Side question: "' + q + '"'));
      const btwResult = await runBtwQuery(q, buildProvider(tuiDisplay), ctx);
      writeOutput(renderBtwAnswer(btwResult.answer, btwResult.tokens));
    }
  }

  writeOutput(chalk.hex('#8a7768')('  Type a task, or :help for commands.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL command handler
// ─────────────────────────────────────────────────────────────────────────────

interface ChatState {
  projectRoot: string;
  activeChatId: string | undefined;
  activeChatHistory: import('../providers/types.js').HistoryMessage[];
  activeChatTitle: string | undefined;
  noSession: boolean;
}

interface ReplCtx {
  // Shared REPL readline. Interactive commands must reuse this instead of
  // creating their own interface — two readlines on one stdin both echo
  // every keypress (doubled characters), and closing the second one pauses
  // stdin, which drains the event loop and kills the REPL.
  rl: readline.Interface | null;
  ctx: Awaited<ReturnType<typeof loadProjectContext>>;
  display: ReturnType<typeof createTerminalDisplay>;
  providerConfig: { model: string; apiKey?: string; baseUrl?: string };
  permissions: PermissionSystem;
  cumulative: { turns: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
  chatState: ChatState;
  sessionPath: string | undefined;
}

interface ReplCommandResult {
  handled: boolean;
  newChatId?: string | undefined;
  newHistory?: import('../providers/types.js').HistoryMessage[];
  newTitle?: string | undefined;
}

/**
 * Best-effort map from a model id to the env-var name its key lives under.
 * Delegates to the factory helper — custom providers from .aura.json are
 * covered because registerCustomProviders runs at startup.
 */
function envNameForModel(model: string): string | undefined {
  return apiKeyEnvVarForModel(model);
}

function trySetModel(c: ReplCtx, newModel: string): { ok: true } | { ok: false; err: string } {
  const prevModel = runtimeConfig.model;
  const prevResolved = resolved.model;
  runtimeConfig.model = newModel;
  resolved.model = newModel; // buildProvider reads resolved.model — keep in sync
  try {
    const test = buildProvider(c.display);
    c.providerConfig.model = newModel;
    console.log(chalk.hex('#5a9e6e')(`  ✓ Switched to ${test.name} · ${newModel}`));
    // Remember the choice for the next session. The saved baseUrl belongs to
    // the wizard-configured model — keep it only when switching back to that
    // model, otherwise the factory's per-provider default applies.
    try {
      saveGlobalConfig({
        provider: globalCfg?.provider ?? test.name,
        // loadGlobalConfig treats an empty apiKeyEnv as "not configured", so
        // derive it from the model to keep the saved choice loadable.
        apiKeyEnv: envNameForModel(newModel) ?? globalCfg?.apiKeyEnv ?? 'AURA_API_KEY',
        defaultModel: newModel,
        baseUrl: savedProvider && newModel === savedProvider.model ? savedProvider.baseUrl : undefined,
      });
    } catch { /* persistence is best-effort; the switch itself succeeded */ }
    return { ok: true };
  } catch (e) {
    runtimeConfig.model = prevModel;  // rollback on error
    resolved.model = prevResolved;
    return { ok: false, err: String(e) };
  }
}

/**
 * Interactive model selector — shows all models grouped by provider,
 * lets the user pick by number or type a custom model ID.
 */
async function showModelSelector(c: ReplCtx): Promise<void> {
  const allModels = getAllModels();

  // Build flat numbered list grouped by provider
  const entries: { id: string; label: string; provider: string }[] = [];
  let currentProvider = '';
  for (const m of allModels) {
    if (m.provider !== currentProvider) {
      currentProvider = m.provider;
      entries.push({ id: '', label: chalk.hex('#8a7768').bold(`  ── ${currentProvider} ──`), provider: currentProvider });
    }
    entries.push({
      id: m.id,
      label: `    ${chalk.hex('#cc785c')(String(entries.length + 1).padStart(2))}. ${chalk.hex('#ede0cc')(m.name.padEnd(30))} ${chalk.hex('#4e3d30')(m.speed)}`,
      provider: m.provider,
    });
  }

  console.log(chalk.hex('#cc785c').bold('\n  Model Selector\n'));
  for (const e of entries) {
    console.log(e.label);
  }
  console.log(chalk.hex('#4e3d30')(`\n  Current: ${runtimeConfig.model}`));
  console.log(chalk.hex('#4e3d30')('  Type a number, model ID, or press Enter to cancel:\n'));

  const answer = await new Promise<string>(resolve => {
        const promptRl = c.rl;
    if (!promptRl) { resolve('y'); return; }
    promptRl.question(chalk.hex('#cc785c')('  ▸ '), resolve);
  });
  const choice = answer.trim();

  if (!choice) {
    console.log(chalk.hex('#4e3d30')('  Cancelled.\n'));
    return;
  }

  // Try as a number
  const num = parseInt(choice, 10);
  if (!isNaN(num) && num >= 1 && num <= entries.length) {
    const selected = entries[num - 1];
    if (selected.id) {
      trySetModel(c, selected.id);
    } else {
      console.log(chalk.hex('#b15439')('  ✗ That\'s a section header, pick a model number.'));
    }
    return;
  }

  // Treat as a raw model ID
  trySetModel(c, choice);
}

async function handleReplCommand(input: string, c: ReplCtx): Promise<ReplCommandResult> {
  const unhandled: ReplCommandResult = { handled: false };

  // ── :q — Task queue (with subcommands, keep bare :q as quit) ─────────────
  if (input.startsWith(':q ')) {
    const sub = input.slice(3).trimStart();
    const { addToQueue, loadQueue, removeFromQueue, clearQueue, runQueueItem, formatQueue }
      = await import('../repl/queue.js');

    if (sub.startsWith('add ')) {
      const prompt = sub.slice(4).trim();
      if (!prompt) {
        c.display.warning('Usage: :q add <prompt> -- add a task to the queue.');
        return { handled: true };
      }
      const item = addToQueue(prompt);
      console.log(chalk.hex('#5a9e6e')(`\n  ✓ Queued #${loadQueue().length}: "${prompt.slice(0, 60)}"\n`));
      return { handled: true };
    }

    if (sub === 'list') {
      const items = loadQueue();
      console.log(formatQueue(items));
      return { handled: true };
    }

    if (sub.startsWith('run ')) {
      const n = parseInt(sub.slice(4).trim(), 10);
      if (isNaN(n) || n < 1) {
        c.display.warning('Usage: :q run <number> — run the task at that position (see :q list).');
        return { handled: true };
      }
      const items = loadQueue();
      if (n > items.length) {
        c.display.warning(`Queue only has ${items.length} item(s).`);
        return { handled: true };
      }
      c.display.agentThinking();
      const result = await runQueueItem(n - 1, buildProvider(c.display), c.ctx, c.permissions, c.display);
      if (!result) {
        c.display.warning('Could not run that item.');
        return { handled: true };
      }
      c.display.success(`Queue item #${n}: ${result.success ? 'done' : 'failed'}`);
      if (result.output) {
        console.log(chalk.hex('#ede0cc')(`  ${result.output.slice(0, 240)}`));
      }
      console.log(chalk.hex('#4e3d30')(`  ${result.turns} turn(s) · ${result.toolCalls} tool call(s).\n`));
      return { handled: true };
    }

    if (sub.startsWith('drop ')) {
      const n = parseInt(sub.slice(5).trim(), 10);
      if (isNaN(n) || n < 1) {
        c.display.warning('Usage: :q drop <number> — remove the task at that position.');
        return { handled: true };
      }
      const removed = removeFromQueue(n - 1);
      if (!removed) {
        c.display.warning(`No item at position ${n}.`);
        return { handled: true };
      }
      console.log(chalk.hex('#5a9e6e')(`\n  ✓ Dropped #${n}: "${removed.prompt.slice(0, 60)}"\n`));
      return { handled: true };
    }

    if (sub === 'clear') {
      const count = loadQueue().length;
      if (count === 0) {
        c.display.warning('Queue is already empty.');
        return { handled: true };
      }
      clearQueue();
      console.log(chalk.hex('#5a9e6e')(`\n  ✓ Queue cleared (${count} item(s) removed).\n`));
      return { handled: true };
    }

    c.display.warning('Usage: :q add <prompt> | :q list | :q run <n> | :q drop <n> | :q clear');
    return { handled: true };
  }

  if (input === ':quit' || input === ':q' || input === '/exit') {
    process.exit(0);
  }

  if (input === ':speak') {
    speakEnabled = !speakEnabled;
    console.log(chalk.hex(speakEnabled ? '#5a9e6e' : '#8a7768')(
      `  🔊 Voice replies ${speakEnabled ? 'ON — Aura will read its answers aloud' : 'OFF'}.\n`,
    ));
    return { handled: true };
  }

  // :approve — flip the session into auto-approve (no per-command y/N prompt).
  //   :approve      → toggle auto ⇄ normal
  //   :approve all  → auto (approve everything for this session)
  //   :approve off  → back to normal (confirm destructive commands again)
  // Dangerous commands are still blocked either way.
  if (input === ':approve' || input === ':approve all' || input === ':approve off') {
    const cur = c.permissions.getLevel();
    let next: PermissionLevel;
    if (input === ':approve off') next = 'normal';
    else if (input === ':approve all') next = 'auto';
    else next = cur === 'auto' ? 'normal' : 'auto';
    c.permissions.setLevel(next);
    if (next === 'auto') {
      console.log(chalk.hex('#d4903a')(
        '  ✅ Auto-approve ON — commands run without asking (dangerous ones still blocked). `:approve off` to re-enable prompts.\n',
      ));
    } else {
      console.log(chalk.hex('#5a9e6e')('  🔒 Auto-approve OFF — destructive commands will ask for confirmation again.\n'));
    }
    return { handled: true };
  }

  if (input === ':dream' || input === ':dream full') {
    const full = input === ':dream full';
    const { runDream } = await import('../dream/dream.js');
    c.display.agentThinking();
    const res = await runDream(c.ctx.root, buildProvider(c.display), full);
    if (res.episodeCount === 0) {
      c.display.warning(full ? 'No episodes recorded at all.' : 'No new episodes since the last dream.');
    } else {
      c.display.success(`Dream written: ${res.dreamPath} (${res.episodeCount} episodes${full ? ', full run' : ''})`);
      if (res.reconciled) c.display.success('Reconciliation also ran (>=3 dreams exist) -> dreams/.reconciled.md');
    }
    return { handled: true };
  }
  if (input.startsWith(':research ') || input === ':research') {
    const topic = input.slice(':research '.length).trim();
    if (!topic) {
      c.display.warning('Usage: :research <topic> -- runs a multi-step research pass and saves to research/*.md.');
      return { handled: true };
    }
    console.log(chalk.hex('#8a7768')(`\n  Researching "${topic}"…\n`));
    try {
      const { runResearch } = await import('../research/research.js');
      const res = await runResearch({
        projectRoot: c.ctx.root,
        topic,
        provider: buildProvider(c.display),
        context: c.ctx,
        permissions: c.permissions,
        display: c.display,
      });
      console.log(chalk.hex('#5a9e6e')(`  ✓ Research written: ${res.path}`));
      console.log(chalk.hex('#8a7768')(`  ${res.turns} turn(s) · ${res.toolCalls} tool call(s).\n`));
    } catch (e) {
      console.log(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }
  if (input === ':confessions') {
    const { listConfessions } = await import('../agent/confess.js');
    const confs = listConfessions();
    if (confs.length === 0) {
      console.log(chalk.hex('#8a7768')('\n  No confessions yet. Run :confess after a high-token episode.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold(`\n  ${confs.length} confession(s):\n`));
      for (const c of confs) {
        console.log(chalk.hex('#8a7768')(`  ${c.file}`));
        console.log(chalk.hex('#4e3d30')(`    ${c.tokens.toLocaleString()} tokens burned → ${c.lesson.slice(0, 100)}`));
      }
      console.log('');
    }
    return { handled: true };
  }
  if (input === ':confess') {
    const { runConfession, findEpisodeToConfess } = await import('../agent/confess.js');
    const targetEp = findEpisodeToConfess(c.ctx.root);
    if (!targetEp) {
      console.log(chalk.hex('#cc9e5c')('\n  No anomalous episode found. Confession is fully automatic — the system alone decides what to confess.\n'));
      return { handled: true };
    }
    console.log(chalk.hex('#8a7768')(`\n  🙏 Confessing episode ${targetEp.id.slice(0,8)}… — ${targetEp.task.slice(0,60)} (${(targetEp.tokens/1e6).toFixed(1)}M tok)\n`));
    try {
      // Use a different model than the one that made the mistake
      const confessorModel = targetEp.model.startsWith('deepseek') ? 'glm-5.2' : 'deepseek/deepseek-chat';
      const { createProvider } = await import('../providers/factory.js');
      const provider = createProvider({ model: confessorModel });
      const result = await runConfession({
        projectRoot: c.ctx.root,
        episodeId: targetEp.id,
        provider,
      });
      console.log(chalk.hex('#5a9e6e')(`  ✓ Confession written: ${result.path}`));
      console.log(chalk.hex('#8a7768')(`  Tokens burned: ${result.tokensBurned.toLocaleString()} | Confession cost: ${result.tokensSpent.toLocaleString()} (${confessorModel})`));
      console.log(chalk.hex('#cc9e6c')('  Permanent lesson:'));
      console.log(chalk.hex('#ede0cc')(`  "${result.lesson}"\n`));
    } catch (e) {
      console.log(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }
  if (input === ':rem') {
    const { getReconciledOrLatest } = await import('../dream/dream.js');
    const res = getReconciledOrLatest(c.ctx.root);
    if (!res) {
      c.display.warning('No dreams yet. Run :dream first.');
    } else {
      console.log(chalk.hex('#8a7768')(`\n  ${res.isReconciled ? 'Reconciled projection' : 'Latest dream (not yet reconciled)'}:\n`));
      console.log(res.content);
    }
    return { handled: true };
  }
  if (input.startsWith(':machina ') || input === ':machina') {
    const machinaTask = input.slice(':machina '.length).trim();
    if (!machinaTask) {
      c.display.warning('Usage: :machina <task> -- runs the task with self-verification (file/test checks + auto-retry).');
      return { handled: true };
    }
    const { runWithVerification } = await import('../verify/index.js');
    const maxRetries = cliMaxVerifyRetries ?? fileConfig.maxVerifyRetries ?? DEFAULTS.maxVerifyRetries;
    const testCommand = cliTestCommand ?? fileConfig.testCommand;
    const wrapperResult = await runWithVerification({
      loopOpts: {
        provider: buildProvider(c.display), task: machinaTask,
        context: c.ctx, permissions: c.permissions, display: c.display,
        initialHistory: c.chatState.activeChatHistory,
        maxTurns: resolved.maxTurns,
        spawnConfig: {
          apiKey: c.providerConfig.apiKey,
          baseUrl: c.providerConfig.baseUrl,
        },
        sessionPath: c.sessionPath,
      },
      config: { enabled: true, maxRetries, testCommand },
      projectRoot: c.ctx.root,
      display: c.display,
    });
    const mResult = wrapperResult.loopResult;
    if (mResult.success) {
      c.display.summary(mResult.summary, mResult.turns, mResult.toolCallCount);
      printUsageFooter(c.display, mResult.usage, mResult.costUsd);
    } else {
      c.display.error(mResult.summary);
    }
    return { handled: true, newHistory: mResult.history };
  }
  if (input.startsWith(':council ') || input === ':council') {
    const councilTask = input.slice(':council '.length).trim();
    if (!councilTask) {
      c.display.warning('Usage: :council <task> -- runs 2-3 read-only domain specialists in parallel, then synthesizes their reports.');
      return { handled: true };
    }
    const { runMixtureOfAgents } = await import('../agent/mixture.js');
    const councilResult = await runMixtureOfAgents({
      provider: buildProvider(c.display), task: councilTask, context: c.ctx, display: c.display,
    });
    if (councilResult.success) {
      c.display.summary(councilResult.summary, councilResult.turns, councilResult.toolCallCount);
      printUsageFooter(c.display, councilResult.usage, councilResult.costUsd);
    } else {
      c.display.error(councilResult.summary);
    }
    return { handled: true };
  }
  // ── :btw — Side channel question (read-only, no history) ────────────────
  if (input.startsWith(':btw ')) {
    const question = input.slice(5).trim();
    if (!question) {
      c.display.warning('Usage: :btw <question> — ask a quick side question without interrupting the current task.');
      return { handled: true };
    }
    const { runBtwQuery, renderBtwAnswer } = await import('../repl/side-channel.js');
    c.display.agentThinking();
    const result = await runBtwQuery(question, buildProvider(c.display), c.ctx);
    console.log(renderBtwAnswer(result.answer, result.tokens));
    return { handled: true };
  }

  if (input === ':help' || input === '/help') {
    console.log(chalk.hex('#8a7768')([
      '',
      '  ── Session ──────────────────────────────────────',
      '  :id                     Show current chat ID',
      '  :sessions               List all saved sessions',
      '  :resume                 Resume the latest session',
      '  :resume <id>            Resume a specific session by ID',
      '  :new                    Start a new session (fresh history)',
      '  :history                Show turn count in current session',
      '  :clear-history          Wipe conversation history (keep session ID)',
      '  :save [title]           Rename / save current session',
      '  :delete <id>            Delete a saved session',
      '',
      '  ── Model / API ──────────────────────────────────',
      '  :model                  Interactive model selector',
      '  :model <id>             Switch to a specific model',
      '  :models                 List all available models',
      '  :provider               Provider setup wizard (pick provider, model, key)',
      '  :apikey <key>           Set API key for current session',
      '',
      '  ── Workflows ─────────────────────────────────────',
      '  :workflows              List all saved workflows',
      '  :workflow               Create & run a multi-step workflow',
      '    <name> "step1" "step2" ...',
      '  :resume-workflow <id>   Resume a paused/failed workflow',
      '  :q add <prompt>         Enqueue a task in the queue',
      '  :q list                 List queued tasks',
      '  :q run <n>              Execute queued task #n',
      '  :q drop <n>             Remove queued task #n',
      '  :q clear                Wipe the queue',
      '  :machina <task>         Run task with self-verification + auto-retry',
      '  :council <task>         2-3 parallel read-only specialists, then synthesis',
      '',
      '  ── Memory / Side ─────────────────────────────────',
      '  :dream                  Consolidate recent episodes into a dream entry',
      '  :dream full             Consolidate ALL episodes, ignoring last-dream cutoff',
      '  :rem                    Show reconciled memory (or latest dream)',
      '  :research <topic>       Multi-step research pass, saved to research/*.md',
      '  :confess                Auto-detect & confess an anomalous episode',
      '  :confessions            List all confessions',
      '  :btw <question>         Quick side question (read-only, no history pollution)',
      '',
      '  ── Voice ─────────────────────────────────────────',
      '  :speak                  Toggle reading replies aloud (or launch with --speak)',
      '',
      '  ── Safety ────────────────────────────────────────',
      '  :approve                Toggle auto-approve (skip per-command y/N prompts)',
      '  :approve all            Approve everything this session',
      '  :approve off            Re-enable confirmation for destructive commands',
      '',
      '  ── Context / Stats ──────────────────────────────',
      '  :context                Show loaded project context',
      '  :graph                  Show codebase knowledge graph summary',
      '  :graph refresh          Reload graph from graphify-out/graph.json',
      '  :plans                  List saved execution plans',
      '  :viz, :dashboard        Generate and open the memory dashboard',
      '  /stats, /usage          Show token + cost usage this session',
      '  /clear, /reset          Reset cumulative usage stats',
      '',
      '  ── General ──────────────────────────────────────',
      '  :quit, :q, /exit        Exit',
      '',
    ].join('\n')));
    return { handled: true };
  }

  // ── Session commands ─────────────────────────────────────────────────────

  if (input === ':id') {
    const cs = c.chatState;
    if (cs.activeChatId) {
      console.log(chalk.hex('#8a7768')(`\n  Chat ID: ${chalk.hex('#cc785c')(cs.activeChatId)}`));
      if (cs.activeChatTitle) console.log(chalk.hex('#8a7768')(`  Title:   ${cs.activeChatTitle}`));
      console.log(chalk.hex('#4e3d30')(`  Turns:   ${Math.floor(cs.activeChatHistory.length / 2)}\n`));
    } else {
      console.log(chalk.hex('#8a7768')('\n  No active session (--no-session mode).\n'));
    }
    return { handled: true };
  }

  if (input === ':sessions') {
    const sessions = sessionStore.listSessions(c.chatState.projectRoot);
    if (sessions.length === 0) {
      console.log(chalk.hex('#8a7768')('\n  No saved sessions.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold('\n  Saved sessions:\n'));
      for (const s of sessions) {
        const updated = new Date(s.updatedAt).toLocaleString();
        const turns = Math.floor(s.history.length / 2);
        const marker = s.id === c.chatState.activeChatId ? chalk.hex('#5a9e6e')(' ← current') : '';
        console.log(
          `  ${chalk.hex('#cc785c')(s.id.padEnd(20))} ` +
          `${chalk.hex('#ede0cc')(s.title.slice(0, 40).padEnd(41))} ` +
          `${chalk.hex('#4e3d30')(`${turns}t · ${updated}`)}${marker}`,
        );
      }
      console.log();
    }
    return { handled: true };
  }

  if (input === ':resume' || input === ':resume ') {
    const latest = sessionStore.findLatestSession(c.chatState.projectRoot);
    if (!latest) {
      console.log(chalk.hex('#8a7768')('\n  No saved sessions to resume.\n'));
      return { handled: true };
    }
    console.log(chalk.hex('#5a9e6e')(`\n  ↩ Resuming ${latest.id} — "${latest.title}" (${Math.floor(latest.history.length / 2)} turns)\n`));
    return { handled: true, newChatId: latest.id, newHistory: latest.history, newTitle: latest.title };
  }

  if (input.startsWith(':resume ')) {
    const id = input.slice(':resume '.length).trim();
    const loaded = await sessionStore.loadSession(c.chatState.projectRoot, id);
    if (!loaded) {
      console.log(chalk.hex('#b15439')(`\n  ✗ Session not found: ${id}\n`));
      return { handled: true };
    }
    console.log(chalk.hex('#5a9e6e')(`\n  ↩ Resumed ${loaded.id} — "${loaded.title}" (${Math.floor(loaded.history.length / 2)} turns)\n`));
    return { handled: true, newChatId: loaded.id, newHistory: loaded.history, newTitle: loaded.title };
  }

  if (input === ':new') {
    const newId = sessionStore.generateId();
    console.log(chalk.hex('#5a9e6e')(`\n  ✓ New session started: ${newId}\n`));
    return { handled: true, newChatId: newId, newHistory: [], newTitle: undefined };
  }

  if (input === ':history') {
    const turns = Math.floor(c.chatState.activeChatHistory.length / 2);
    console.log(chalk.hex('#8a7768')(`\n  Current session: ${turns} turn${turns !== 1 ? 's' : ''} in history.\n`));
    return { handled: true };
  }

  if (input === ':clear-history') {
    console.log(chalk.hex('#5a9e6e')('\n  ✓ Conversation history cleared.\n'));
    return { handled: true, newHistory: [] };
  }

  if (input === ':save' || input.startsWith(':save ')) {
    const title = input.startsWith(':save ') ? input.slice(':save '.length).trim() : undefined;
    const cs = c.chatState;
    if (!cs.activeChatId) {
      console.log(chalk.hex('#8a7768')('\n  No active session to save (--no-session mode).\n'));
      return { handled: true };
    }
    const session = await sessionStore.upsertSession(cs.projectRoot, cs.activeChatId, cs.activeChatHistory, title ?? cs.activeChatTitle);
    console.log(chalk.hex('#5a9e6e')(`\n  ✓ Saved as "${session.title}" (${cs.activeChatId})\n`));
    return { handled: true, newTitle: session.title };
  }

  if (input.startsWith(':delete ')) {
    const id = input.slice(':delete '.length).trim();
    const deleted = await sessionStore.deleteSession(c.chatState.projectRoot, id);
    if (deleted) {
      console.log(chalk.hex('#5a9e6e')(`\n  ✓ Deleted session ${id}\n`));
      if (id === c.chatState.activeChatId) {
        const newId = sessionStore.generateId();
        console.log(chalk.hex('#8a7768')(`  Starting new session: ${newId}\n`));
        return { handled: true, newChatId: newId, newHistory: [], newTitle: undefined };
      }
    } else {
      console.log(chalk.hex('#b15439')(`\n  ✗ Session not found: ${id}\n`));
    }
    return { handled: true };
  }

  // ── Model / API commands ─────────────────────────────────────────────────

  if (input === ':context') {
    console.log(chalk.hex('#8a7768')(`\n  Project: ${c.ctx.name} · ${c.ctx.language} · ${c.ctx.framework}`));
    console.log(chalk.hex('#4e3d30')(`  Root: ${c.ctx.root}\n`));
    return { handled: true };
  }

  if (input === ':graph') {
    const summary = loadGraphSummary(c.ctx.root);
    if (!summary) {
      console.log(chalk.hex('#8a7768')('\n  No graph.json found. Run :graph refresh to extract.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold('\n  Codebase Knowledge Graph\n'));
      console.log(chalk.hex('#8a7768')(summary));
      console.log();
    }
    return { handled: true };
  }

  if (input === ':viz' || input === ':dashboard') {
    console.log(chalk.hex('#8a7768')('\n  Generating dashboard…\n'));
    try {
      const outPath = generateDashboard(c.ctx.root);
      console.log(chalk.hex('#5a9e6e')(`  ✓ Dashboard written to ${outPath}`));
      console.log(chalk.hex('#8a7768')('  Opening in browser…\n'));
      openDashboard(outPath);
    } catch (e) {
      console.log(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }

  if (input === ':plans') {
    const { planStore } = await import('../orchestration/plan-store.js');
    const plans = await planStore.list();
    if (!plans.length) {
      console.log(chalk.hex('#8a7768')('\n  No execution plans found.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold('\n  Execution plans:\n'));
      for (const p of plans.slice(0, 15)) {
        const created = new Date(p.created).toLocaleString();
        const dur = p.completed ? `${Math.round((p.completed - p.created) / 1000)}s` : '—';
        const statusColor = p.status === 'done' ? '#5a9e6e' : p.status === 'failed' ? '#b15439' : '#cc9e5c';
        console.log(
          `  ${chalk.hex(statusColor)(p.status.padEnd(8))} ` +
          `${chalk.hex('#cc785c')(p.id.slice(0, 12).padEnd(14))} ` +
          `${chalk.hex('#ede0cc')(p.goal.slice(0, 50).padEnd(51))} ` +
          `${chalk.hex('#4e3d30')(`${p.steps.length}s · ${dur} · ${created}`)}`,
        );
      }
      console.log();
    }
    return { handled: true };
  }

  if (input === ':graph refresh') {
    console.log(chalk.hex('#8a7768')('\n  Refreshing codebase graph...\n'));
    const { execSync } = await import('child_process');
    try {
      execSync(
        'python3 -c "' +
        'import json,os,re,glob; ' +
        'root=\\\"' + c.ctx.root + '/src\\\"; ' +
        'print(\\\"Scanning\\\", root)" ',
        { stdio: 'inherit' }
      );
    } catch { /* ignore */ }
    // Reload context graph
    c.ctx.graphSummary = loadGraphSummary(c.ctx.root);
    if (c.ctx.graphSummary) {
      console.log(chalk.hex('#5a9e6e')('  ✓ Graph loaded and injected into context.\n'));
    } else {
      console.log(chalk.hex('#8a7768')('  No graph.json found after refresh. Run graphify extract first.\n'));
    }
    return { handled: true };
  }

  // ── Provider wizard command ────────────────────────────────────────────────
  if (input === ':provider' || input === '/provider') {
    const cfg = await runProviderWizard(c.rl ?? undefined);
    if (cfg) {
      // Update current session's provider without restart
      runtimeConfig.model = cfg.model;
      runtimeConfig.baseUrl = cfg.baseUrl;
      runtimeConfig.apiKey = cfg.apiKey;
      c.providerConfig.model = cfg.model;
      c.providerConfig.baseUrl = cfg.baseUrl;
      c.providerConfig.apiKey = cfg.apiKey;
      // Keep resolved in sync
      resolved.model = cfg.model;
      resolved.baseUrl = cfg.baseUrl;
      console.log(chalk.hex('#5a9e6e')(`  ✓ Now using ${cfg.provider} · ${cfg.model}`));
      // The wizard saves to the global config, but a project .aura.json model
      // outranks it on the next startup — warn so the switch doesn't appear lost.
      if (fileConfig.model && fileConfig.model !== cfg.model) {
        console.log(chalk.hex('#8a7768')(
          `  ⚠ .aura.json pins model "${fileConfig.model}" — next startup in this project will use it.\n` +
          `    Remove the "model" field from .aura.json (or set it to ${cfg.model}) to keep this choice.`,
        ));
      }
    }
    return { handled: true };
  }

  if (input === ':models') {
    const allModels = getAllModels();
    const byProvider = allModels.reduce<Record<string, typeof allModels>>((acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    }, {});
    for (const [provider, models] of Object.entries(byProvider)) {
      console.log(chalk.hex('#8a7768')(`\n  ${provider}`));
      for (const m of models) {
        console.log(`    ${chalk.hex('#cc785c')(m.id.padEnd(45))} ${chalk.hex('#4e3d30')(m.speed)}`);
      }
    }
    console.log();
    return { handled: true };
  }

  if (input === ':model' || input === '/model') {
    await showModelSelector(c);
    return { handled: true };
  }

  if (input.startsWith(':model ') || input.startsWith('/model ')) {
    const sep = input.startsWith(':model ') ? ':model ' : '/model ';
    const newModel = input.slice(sep.length).trim();
    const r = trySetModel(c, newModel);
    if (!r.ok) console.log(chalk.hex('#b15439')(`  ✗ ${r.err}`));
    return { handled: true };
  }

  if (input.startsWith(':apikey ') || input.startsWith('/apikey ')) {
    const sep = input.startsWith(':apikey ') ? ':apikey ' : '/apikey ';
    const newKey = input.slice(sep.length).trim();
    runtimeConfig.apiKey = newKey;
    c.providerConfig.apiKey = newKey;
    // Persist it so it survives across sessions (fixes "type the key every
    // time"). Save under the env-var name for the current provider, and also
    // set that env var live so getApiKey resolves it this session.
    const envName = globalCfg?.apiKeyEnv || envNameForModel(resolved.model ?? '');
    if (envName) {
      try {
        const p = saveKey(envName, newKey);
        console.log(chalk.hex('#5a9e6e')(`  ✓ API key saved as ${envName} → ${p} (persists across sessions).`));
      } catch (e) {
        console.log(chalk.hex('#5a9e6e')('  ✓ API key set for current session (could not persist: ' + String(e) + ').'));
      }
    } else {
      console.log(chalk.hex('#5a9e6e')('  ✓ API key set for current session.'));
    }
    return { handled: true };
  }

  if (input === '/clear' || input === '/reset') {
    c.cumulative.turns = 0;
    c.cumulative.toolCalls = 0;
    c.cumulative.inputTokens = 0;
    c.cumulative.outputTokens = 0;
    c.cumulative.costUsd = 0;
    console.log(chalk.hex('#5a9e6e')('  ✓ Session stats reset'));
    return { handled: true };
  }

  if (input === '/stats' || input === '/usage') {
    const u = c.cumulative;
    const total = u.inputTokens + u.outputTokens;
    console.log(chalk.hex('#8a7768')([
      '',
      `  Session usage:`,
      `    Turns:        ${u.turns}`,
      `    Tool calls:   ${u.toolCalls}`,
      `    Input tokens: ${u.inputTokens.toLocaleString()}`,
      `    Output tokens:${u.outputTokens.toLocaleString()}`,
      `    Total tokens: ${total.toLocaleString()}`,
      `    Est. cost:    ${u.costUsd.toFixed(4)}`,
      '',
    ].join('\n')));
    return { handled: true };
  }

  // ── Workflow commands ──────────────────────────────────────────────────────

  if (input === ':workflows') {
    const workflows = await listWorkflows();
    if (workflows.length === 0) {
      console.log(chalk.hex('#8a7768')('\n  No saved workflows.\n'));
    } else {
      console.log(chalk.hex('#cc785c').bold('\n  Saved workflows:\n'));
      for (const ws of workflows) {
        const created = new Date(ws.definition.createdAt).toLocaleString();
        const doneSteps = ws.stepStates.filter(s => s.status === 'done').length;
        const totalSteps = ws.definition.steps.length;
        const statusColor = ws.status === 'done' ? '#5a9e6e' : ws.status === 'failed' ? '#b15439' : '#cc785c';
        console.log(
          `  ${chalk.hex('#cc785c')(ws.definition.id.padEnd(24))} ` +
          `${chalk.hex('#ede0cc')(ws.definition.name.slice(0, 36).padEnd(37))} ` +
          `${chalk.hex(statusColor)(ws.status.padEnd(8))} ` +
          `${chalk.hex('#4e3d30')(`${doneSteps}/${totalSteps} steps · ${created}`)}`,
        );
      }
      console.log();
    }
    return { handled: true };
  }

  if (input.startsWith(':workflow ')) {
    const parts = input.slice(':workflow '.length).trim();
    // Parse: <name> "step1" "step2" ...  or  <name> step1 step2 ...
    const match = parts.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      console.log(chalk.hex('#b15439')('  ✗ Usage: :workflow <name> "step 1" "step 2" ...'));
      return { handled: true };
    }
    const workflowName = match[1];
    // Split remaining by quoted strings or spaces
    const restStr = match[2];
    const stepTasks: string[] = [];
    const quotedRe = /"([^"]+)"|'([^']+)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = quotedRe.exec(restStr)) !== null) {
      stepTasks.push(m[1] ?? m[2] ?? m[3]);
    }

    if (stepTasks.length === 0) {
      console.log(chalk.hex('#b15439')('  ✗ At least one step task is required.'));
      return { handled: true };
    }

    const steps: WorkflowStep[] = stepTasks.map((task: string, i: number) => ({
      name: `step-${i + 1}`,
      task,
    }));

    console.log(chalk.hex('#cc785c').bold(`\n  Creating workflow "${workflowName}" with ${steps.length} steps...\n`));

    const state = await createWorkflow({ name: workflowName, steps });
    console.log(chalk.hex('#5a9e6e')(`  ✓ Workflow created: ${state.definition.id}\n`));

    // Build the runStep callback using the REPL context's provider
    const runStep = async (task: string, stepIndex: number): Promise<StepResult> => {
      console.log(chalk.hex('#cc785c')(`  ▸ Step ${stepIndex + 1}/${steps.length}: ${task}\n`));

      const { createResilientProvider } = await import('../providers/resilient-factory.js');
      const currentProvider = createResilientProvider(
        { model: c.providerConfig.model, apiKey: c.providerConfig.apiKey, baseUrl: c.providerConfig.baseUrl },
        {},
        c.display,
      );
      const result = await runAgentLoop({
        provider: currentProvider, task, context: c.ctx, permissions: c.permissions,
        display: c.display, initialHistory: [], maxTurns: undefined,
        spawnConfig: { apiKey: c.providerConfig.apiKey, baseUrl: c.providerConfig.baseUrl },
      });

      return {
        success: result.success,
        summary: result.summary,
        turns: result.turns,
        toolCallCount: result.toolCallCount,
        tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
      };
    };

    const finalState = await runWorkflow(state, runStep);
    if (finalState.status === 'done') {
      console.log(chalk.hex('#5a9e6e').bold(`\n  ✓ ${finalState.outcome}\n`));
    } else {
      console.log(chalk.hex('#b15439').bold(`\n  ✗ ${finalState.outcome}`));
      console.log(chalk.hex('#8a7768')(`  Resume with: :resume-workflow ${finalState.definition.id}\n`));
    }

    return { handled: true };
  }

  if (input.startsWith(':resume-workflow ')) {
    const workflowId = input.slice(':resume-workflow '.length).trim();
    if (!workflowId) {
      console.log(chalk.hex('#b15439')('  ✗ Usage: :resume-workflow <id>'));
      return { handled: true };
    }

    console.log(chalk.hex('#cc785c').bold(`\n  Resuming workflow ${workflowId}...\n`));

    const runStep = async (task: string, stepIndex: number): Promise<StepResult> => {
      console.log(chalk.hex('#cc785c')(`  ▸ Step ${stepIndex + 1}: ${task}\n`));

      const { createResilientProvider } = await import('../providers/resilient-factory.js');
      const currentProvider = createResilientProvider(
        { model: c.providerConfig.model, apiKey: c.providerConfig.apiKey, baseUrl: c.providerConfig.baseUrl },
        {},
        c.display,
      );
      const result = await runAgentLoop({
        provider: currentProvider, task, context: c.ctx, permissions: c.permissions,
        display: c.display, initialHistory: [], maxTurns: undefined,
        spawnConfig: { apiKey: c.providerConfig.apiKey, baseUrl: c.providerConfig.baseUrl },
      });

      return {
        success: result.success,
        summary: result.summary,
        turns: result.turns,
        toolCallCount: result.toolCallCount,
        tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
      };
    };

    const finalState = await resumeWorkflow(workflowId, runStep);
    if (!finalState) {
      console.log(chalk.hex('#b15439')(`  ✗ Workflow not found: ${workflowId}\n`));
      return { handled: true };
    }

    if (finalState.status === 'done') {
      console.log(chalk.hex('#5a9e6e').bold(`\n  ✓ ${finalState.outcome}\n`));
    } else {
      console.log(chalk.hex('#b15439').bold(`\n  ✗ ${finalState.outcome}`));
      console.log(chalk.hex('#8a7768')(`  Resume with: :resume-workflow ${finalState.definition.id}\n`));
    }

    return { handled: true };
  }

  return unhandled;
}

/**
 * Architect mode: produce a blueprint without writing any code.
 * The agent analyses the task, proposes files/interfaces/data models,
 * and the blueprint is saved to ~/.aura/blueprints/<id>.json.
 */
async function runArchitectPlan(
  task: string,
  provider: LLMProvider,
  ctx: Awaited<ReturnType<typeof loadProjectContext>>,
  display: ReturnType<typeof createTerminalDisplay>,
): Promise<void> {
  display.header('Architect', 'Analysing task and producing blueprint...');

  const architectPrompt = [
    `You are in architect mode. You are planning the implementation for: "${task}"`,
    '',
    'Project context:',
    `  Language: ${ctx.language}`,
    `  Framework: ${ctx.framework}`,
    `  Root: ${ctx.root}`,
    '',
    'Rules for architect mode:',
    '1. Think about the FULL solution before proposing any file.',
    '2. Propose the MINIMUM number of files needed.',
    '3. Name files after what they DO, not what they ARE.',
    '4. Define interfaces before implementations.',
    '5. Flag any ambiguous parts of the task as risks.',
    '6. Do NOT write any code. Only plan.',
    '',
    'Output format — respond with ONLY this JSON object (no markdown fences, no extra text):',
    JSON.stringify({
      files: [
        {
          path: 'src/example.ts',
          purpose: 'What this file does (one sentence)',
          exports: ['exportedSymbol'],
          interfaces: ['InterfaceName'],
        },
      ],
      dataModels: [
        {
          name: 'ModelName',
          fields: ['field: type'],
          description: 'What this model represents',
        },
      ],
      dependencies: ['external-package-or-module'],
      risks: ['Ambiguous part or concern'],
      estimatedSteps: 0,
    }, null, 2),
    '',
    'Now produce the blueprint JSON for the task described above.',
  ].join('\n');

  const permissions = new PermissionSystem('read-only');

  let result;
  try {
    result = await runAgentLoop({
      provider, task: architectPrompt, context: ctx, permissions, display,
      initialHistory: [],
      maxTurns: 5,
      spawnConfig: {
        apiKey: runtimeConfig.apiKey,
        baseUrl: runtimeConfig.baseUrl ?? undefined,
      },
    });
  } catch (e) {
    display.error(`Architect analysis failed: ${String(e)}`);
    process.exit(1);
  }

  // Parse the agent's response for a JSON blueprint
  const responseText = result.summary;
  let parsed: {
    files?: Array<{ path: string; purpose: string; exports?: string[]; interfaces?: string[] }>;
    dataModels?: Array<{ name: string; fields?: string[]; description?: string }>;
    dependencies?: string[];
    risks?: string[];
    estimatedSteps?: number;
  };

  try {
    // Try to extract JSON from the response (may have surrounding text)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // If the agent didn't produce valid JSON, create a minimal blueprint with the raw response
    parsed = {
      files: [],
      dataModels: [],
      dependencies: [],
      risks: [`Agent response was not valid JSON: ${responseText.slice(0, 200)}`],
      estimatedSteps: 0,
    };
  }

  const blueprint = await createBlueprint(task, ctx.root, {
    files: (parsed.files ?? []).map(f => ({
      path: f.path,
      purpose: f.purpose,
      exports: f.exports ?? [],
      interfaces: f.interfaces ?? [],
      status: 'planned' as const,
    })),
    dataModels: (parsed.dataModels ?? []).map(dm => ({
      name: dm.name,
      fields: dm.fields ?? [],
      description: dm.description ?? '',
    })),
    dependencies: parsed.dependencies ?? [],
    risks: parsed.risks ?? [],
    estimatedSteps: parsed.estimatedSteps ?? parsed.files?.length ?? 0,
  });

  // Display result
  console.log(chalk.hex('#cc785c').bold('\n  Blueprint\n'));
  console.log(chalk.hex('#ede0cc')(`  Task: ${blueprint.task}`));
  console.log(chalk.hex('#4e3d30')(`  ID: ${blueprint.id}\n`));

  if (blueprint.files.length > 0) {
    console.log(chalk.hex('#cc785c').bold('  Files:\n'));
    for (const f of blueprint.files) {
      console.log(`    ${chalk.hex('#cc785c')(f.path)}`);
      console.log(`      ${chalk.hex('#8a7768')(f.purpose)}`);
      if (f.exports.length > 0) console.log(`      ${chalk.hex('#4e3d30')(`exports: ${f.exports.join(', ')}`)}`);
      if (f.interfaces.length > 0) console.log(`      ${chalk.hex('#4e3d30')(`interfaces: ${f.interfaces.join(', ')}`)}`);
    }
  }

  if (blueprint.dataModels.length > 0) {
    console.log(chalk.hex('#cc785c').bold('\n  Data Models:\n'));
    for (const dm of blueprint.dataModels) {
      console.log(`    ${chalk.hex('#cc785c')(dm.name)} — ${chalk.hex('#8a7768')(dm.description)}`);
    }
  }

  if (blueprint.risks.length > 0) {
    console.log(chalk.hex('#b15439').bold('\n  Risks:\n'));
    for (const risk of blueprint.risks) {
      console.log(`    ${chalk.hex('#b15439')('⚠')} ${chalk.hex('#8a7768')(risk)}`);
    }
  }

  console.log(chalk.hex('#5a9e6e')('\n  Blueprint saved. No files were modified.'));
  console.log(chalk.hex('#5a9e6e')(`  Review with: ruby --blueprint ${blueprint.id}`));
  console.log(chalk.hex('#5a9e6e')(`  Build with: ruby --build ${blueprint.id}\n`));
}

async function runOrchestratedTask(
  task: string,
  provider: LLMProvider,
  ctx: Awaited<ReturnType<typeof loadProjectContext>>,
  display: ReturnType<typeof createTerminalDisplay>,
  forceOrchestrate: boolean,
  perception?: Awaited<ReturnType<typeof extractPerception>>,
): Promise<void> {
  display.header('Orchestrator', 'Planning multi-agent execution...');

  let plan;
  try {
    plan = await createPlan({ provider, context: ctx, task, perception });
  } catch (e) {
    display.error(`Failed to create plan: ${String(e)}`);
    process.exit(1);
  }

  // If --plan flag, show plan and ask for confirmation
  if (argv.plan === true) {
    display.showPlan?.(plan);

    // Use a simple readline prompt for confirmation — reuse the REPL's
    // readline when one is active (second interface double-echoes and
    // pauses stdin on close).
    const sharedRl = getSharedReadline();
    const rl = sharedRl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
    const approved = await new Promise<boolean>(resolve => {
      rl.question(chalk.hex('#cc785c')('\n  Run this plan? [y/N] '), answer => {
        if (!sharedRl) rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });

    if (!approved) {
      console.log(chalk.hex('#4e3d30')('  Plan cancelled.\n'));
      process.exit(0);
    }
  }

  // Execute the plan
  let executedPlan;
  try {
    executedPlan = await executePlan({
      provider,
      context: ctx,
      perception,
      plan,
      display,
    });
  } catch (e) {
    display.error(`Plan execution error: ${String(e)}`);
    process.exit(1);
  }

  // Display outcome
  if (executedPlan.outcome) {
    display.summary(executedPlan.outcome, executedPlan.steps.length, 0);
  }

  const totalTokens = executedPlan.totalTokens ?? 0;
  console.log(chalk.hex('#4e3d30')(
    `  ↳ ${totalTokens.toLocaleString()} tokens · ${executedPlan.steps.length} steps · status: ${executedPlan.status}`,
  ));
}

function printUsageFooter(
  display: ReturnType<typeof createTerminalDisplay>,
  usage: { inputTokens: number; outputTokens: number },
  costUsd: number,
): void {
  const total = usage.inputTokens + usage.outputTokens;
  console.log(chalk.hex('#4e3d30')(
    `  ↳ ${total.toLocaleString()} tokens (${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out) · est. $${costUsd.toFixed(4)}`,
  ));
}

/**
 * Read a task summary aloud (the "Aura talks back" half of the voice loop).
 * Best-effort: strips code/markdown, caps length so a long report doesn't
 * monologue, and never throws into the caller (a TTS/network failure must
 * not break a successful task).
 */
async function speakSummary(text: string): Promise<void> {
  if (!text || !text.trim()) return;
  // Strip fenced code blocks, inline code, markdown markers, and collapse
  // whitespace — TTS should read the prose, not backticks and hashes.
  const spoken = text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`[^`]*`/g, '')
    .replace(/[#*_>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  if (!spoken) return;
  try {
    const { speakText } = await import('../tools/dictate.js');
    await speakText(spoken);
  } catch { /* speech is best-effort — never break the task on TTS failure */ }
}

function printHelp() {
  console.log(`
${chalk.hex('#cc785c').bold('  aura')} ${chalk.hex('#8a7768')("— Aura Code: model-agnostic AI coding agent")}

  ${chalk.hex('#4e3d30')('Usage:')}
    aura ${chalk.hex('#8a7768')('"<task>"')}                           Run a single task
    aura ${chalk.hex('#8a7768')('serve')}                              Start the HTTP API server
    aura ${chalk.hex('#8a7768')('--interactive')}                      Start interactive REPL
    aura ${chalk.hex('#8a7768')('--models')}                           List available models

  ${chalk.hex('#4e3d30')('Options:')}
    --model, -m <id>         Model to use (default: from ~/.config/aura-code/config.json)
    --api-key <key>          API key (overrides env var)
    --base-url <url>         Custom API endpoint (for Ollama, proxies, etc.)
    --auto                   Auto-approve all tool calls (no confirmation)
    --readonly               Read-only mode (no file writes or shell commands)
    --cwd <path>             Working directory (default: current)
    --models                 List all known model IDs
    --no-session             Disable conversation history persistence
    --new-session            Force a fresh session (ignore any prior history)
    --resume [id]            Resume latest session, or a specific session by ID
    --chat-id <id>           Attach to a specific chat ID (creates if missing)
    --list-sessions          List all saved sessions for this project
    --no-setup               Skip the first-run setup wizard
    --reset-setup            Wipe saved config and re-run the setup wizard
    --orchestrate            Force multi-agent orchestration mode
    --architect "task"       Blueprint mode: plan-only, no code written, produces blueprint
    --blueprint <id>         Show a saved blueprint by ID
    --blueprints             List all saved blueprints
    --build [id]             Full orchestrated build; --build <id> builds from blueprint
    --plan                   Preview execution plan before running
    --verify                 Verify output after task; retry up to --max-verify-retries times
    --max-verify-retries <n> Max verification retries (default: 3)
    --test-command <cmd>     Shell command run as part of verification (e.g. "npm test")
    --max-turns <n>          Max agent loop turns before stopping (default: sized by task shape)
    --moa                    Mixture of agents: parallel read-only domain perspectives + synthesis (exploratory tasks only)
    --analyze                Mine session history for weakness patterns; save report
    --propose-harness        Generate system-prompt patches from weakness report
    --apply-harness <id>     Apply a proposal patch; reverts if tests fail
    --workflow <name> ...    Create and run a sequential workflow with named steps
    --resume-workflow <id>   Resume a paused/failed workflow from last completed step
    --workflows              List all persisted workflows
    --profile local          Use local Ollama model (no API key required)

    --rate-limit-rpm <n>     Cap requests per minute (default: 0=unlimited, Google: 30)
    --rate-limit-tpm <n>     Cap tokens per minute (Google only; default: 0=unlimited)
    --max-retries <n>        Max retry attempts on 429/5xx (default: 5, Google: 6)
    --fallback <model>       Fallback model if primary exhausts retries (repeatable)
    --verify                 Enable post-task verification with automatic retries

  ${chalk.hex('#4e3d30')('Resilience:')}
    All API calls automatically:
    1. Honour Retry-After / Google's retryDelay on 429s
    2. Back off with exponential + jitter (capped at 60s)
    3. Trip a circuit breaker after 5 consecutive failures
    4. Fail over to the next --fallback model if retries exhaust
    5. Pace requests when --rate-limit-rpm / --rate-limit-tpm is set

  ${chalk.hex('#4e3d30')('Project config (.aura.json):')}
    {
      "model": "claude-sonnet-4-5-20251001",
      "mode":  "auto",
      "providers": [
        {
          "name": "DeepSeek",
          "baseUrl": "https://api.deepseek.com/v1",
          "apiKeyEnv": "DEEPSEEK_API_KEY",
          "prefixes": ["deepseek/"],
          "models": [
            { "id": "deepseek/deepseek-chat", "name": "DeepSeek Chat", "speed": "Fast" },
            { "id": "deepseek/deepseek-reasoner", "name": "DeepSeek R1", "speed": "Reasoning" }
          ]
        }
      ],
      "rateLimitRpm": 30,
      "rateLimitTpm": 1000000,
      "maxTurns": 150,
      "maxRetries": 6,
      "fallbacks": ["gpt-4o-mini", "gemini-2.5-flash"],
      "ignore": ["dist/", "*.generated.ts"]
    }
    CLI flags always override .aura.json.
    Custom providers are OpenAI-compatible endpoints.

  ${chalk.hex('#4e3d30')('Model examples:')}
    aura -m claude-opus-4-5-20251001  "refactor auth"
    aura -m gpt-4o                    "add unit tests"
    aura -m gemini-2.5-pro --rate-limit-rpm 20  "explain this codebase"
    aura -m ollama/llama3.2           "local model, no API key needed"

  ${chalk.hex('#4e3d30')('API keys (set as env vars):')}
    ANTHROPIC_API_KEY    Claude models
    OPENAI_API_KEY       GPT models
    GOOGLE_API_KEY       Gemini models
    XAI_API_KEY          Grok models
    OPENROUTER_API_KEY   OpenRouter (access to all models)
    XIAOMI_API_KEY       Xiaomi MiMo
    ZHIPU_API_KEY        Zhipu GLM (Z.ai) — glm-* general endpoint, zhipu-coding/<model> Coding Plan
    ZHIPU_BASE_URL       Override Zhipu endpoint (default https://api.z.ai/api/paas/v4)
    AURA_MODEL           Default model (overridden by --model)
    AURA_API_RPM         Default request rate limit
    AURA_API_TPM         Default token rate limit (Gemini)
    AURA_MAX_RETRIES     Default max retry attempts
    AURA_FALLBACK_MODEL  Comma-separated fallback models
`);
}

if (argv._[0] === 'serve') {
  const port = Number(argv.port ?? argv.p ?? 7337);
  startServer({ port, cwd, model: argv.model, apiKey: argv['api-key'] ?? undefined, baseUrl: argv['base-url'] ?? undefined, open: argv.open !== false }).catch(e => { console.error('Fatal:', String(e)); process.exit(1); });
} else {
  main().catch(e => { console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`)); process.exit(1); });
}

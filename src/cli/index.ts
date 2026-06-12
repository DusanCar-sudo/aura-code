#!/usr/bin/env node
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import minimist from 'minimist';
import chalk from 'chalk';

import { KNOWN_MODELS, getAllModels, registerCustomProviders } from '../providers/factory.js';
import { createResilientProvider } from '../providers/resilient-factory.js';
import { loadProjectContext, loadGraphSummary } from '../agent/context.js';
import { generateDashboard, openDashboard } from '../viz/index.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import { createTerminalDisplay } from './display.js';
import { startServer } from '../server/index.js';
import type { PermissionLevel } from '../safety/permissions.js';
import { loadProjectConfig, resolveConfig } from '../config/project-config.js';
import { DEFAULTS } from '../config/defaults.js';
import { sessionStore } from '../agent/session-store.js';
import type { LLMProvider } from '../providers/types.js';
import { loadGlobalConfig, globalConfigPath } from '../setup/global-config.js';
import { needsWizard, runFirstRunWizard, hasGlobalConfig, hasAnyEnvKey } from '../setup/first-run.js';
import { routeTask, createPlan, executePlan } from '../orchestration/index.js';
import { loadPerception, isStale, extractPerception } from '../perception/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Parse args
// ─────────────────────────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string:  ['model', 'm', 'api-key', 'base-url', 'mode', 'cwd', 'rate-limit-rpm', 'rate-limit-tpm', 'max-retries', 'max-verify-retries', 'max-turns', 'fallback', 'resume', 'chat-id', 'profile', 'test-command'],
  boolean: ['help', 'h', 'version', 'v', 'auto', 'readonly', 'models', 'no-session', 'no-setup', 'reset-setup', 'orchestrate', 'plan', 'list-sessions', 'new-session', 'verify'],
  alias:   { m: 'model', h: 'help', v: 'version' },
  default: {
    model: process.env.RUBY_MODEL,
    mode:  'normal',
  },
});

function num(s: unknown): number | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const cliMaxRetries      = num(argv['max-retries']) ?? num(process.env.RUBY_MAX_RETRIES);
const cliMaxVerifyRetries = num(argv['max-verify-retries']);
const cliMaxTurns        = num(argv['max-turns']);
const cliVerify          = argv.verify === true;
const cliProfile         = typeof argv.profile === 'string' ? argv.profile : undefined;
const cliTestCommand     = typeof argv['test-command'] === 'string' ? argv['test-command'] : undefined;
const cliRpm             = num(argv['rate-limit-rpm']) ?? num(process.env.RUBY_API_RPM);
const cliTpm             = num(argv['rate-limit-tpm']) ?? num(process.env.RUBY_API_TPM);
const cliFallbacks: string[] =
  Array.isArray(argv.fallback)
    ? argv.fallback.map(String)
    : typeof argv.fallback === 'string'
      ? [argv.fallback]
      : process.env.RUBY_FALLBACK_MODEL
        ? [process.env.RUBY_FALLBACK_MODEL]
        : [];

// ─────────────────────────────────────────────────────────────────────────────
// Help / version
// ─────────────────────────────────────────────────────────────────────────────

if (argv.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  console.log(`BootstrapRuby v${pkg.version}`);
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
  console.log(chalk.hex('#4e3d30')('\n  Use --model <id> or set RUBY_MODEL env var'));
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
// Resolve config — CLI > .rubycode.json > global config > first-run wizard
// ─────────────────────────────────────────────────────────────────────────────

const cwd = argv.cwd ? path.resolve(argv.cwd) : process.cwd();
const fileConfig = loadProjectConfig(cwd);

// Pull global config (saved by the first-run wizard) so the user doesn't have
// to re-set their provider on every run.
const globalCfg = loadGlobalConfig();

// Effective model = CLI > RUBY_MODEL env > .rubycode.json > global config > undefined
const cliModel = typeof argv.model === 'string' ? argv.model : undefined;
const effectiveModel = cliModel ?? fileConfig.model ?? globalCfg?.defaultModel ?? process.env.RUBY_MODEL;

// Effective base URL = CLI > .rubycode.json > global config > undefined
const cliBaseUrl = typeof argv['base-url'] === 'string' ? argv['base-url'] : undefined;
const effectiveBaseUrl = cliBaseUrl ?? fileConfig.baseUrl ?? globalCfg?.baseUrl;

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

// Register custom providers from .rubycode.json
registerCustomProviders(resolved.providers);

const permissionLevel: PermissionLevel = resolved.mode;

// Mutable runtime state — :model command updates this
const runtimeConfig = {
  model: resolved.model,
  baseUrl: resolved.baseUrl,
  apiKey: typeof argv['api-key'] === 'string' ? argv['api-key'] : undefined,
};

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
  //   - pipe = test harnesses (and `ruby-code | tee log`)
  // The one-shot path (`ruby-code "task"`) has argv._.length > 0 so the
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
    // Wipe global config so the wizard fires unconditionally.
    try { fs.unlinkSync(globalConfigPath()); } catch { /* not present */ }
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
    const cfg = await runFirstRunWizard();
    if (!cfg) {
      console.error(chalk.hex('#b15439')('\n  ✗ Setup cancelled. Set an API key env var (e.g. export OPENAI_API_KEY=...) or run with --api-key.\n'));
      process.exit(1);
    }
    // Re-resolve with the new global config
    const fresh = loadGlobalConfig();
    if (fresh) {
      resolved.model = fresh.defaultModel;
      resolved.baseUrl = fresh.baseUrl;
      runtimeConfig.model = fresh.defaultModel;
      runtimeConfig.baseUrl = fresh.baseUrl;
    }
  }

  let ctx;
  try {
    ctx = await loadProjectContext(cwd);
  } catch (e) {
    display.error(`Could not load project context: ${String(e)}`);
    process.exit(1);
  }

  // ── Guard: we need a model before we can build a provider ─────────────────
  if (!resolved.model) {
    console.error(chalk.hex('#b15439')('\n  ✗ No model configured.'));
    console.error(chalk.hex('#8a7768')('  Run `bootstrapruby` with no args in a TTY to launch the setup wizard,'));
    console.error(chalk.hex('#8a7768')('  or pass --model <id> --api-key <key> on the command line,'));
    console.error(chalk.hex('#8a7768')('  or set the model in .rubycode.json (`"model": "..."`).'));
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

  display.header(
    `BootstrapRuby — ${ctx.name}`,
    `${provider.name} · ${runtimeConfig.model} · ${ctx.language} · ${permissionLevel} mode` +
    (fileConfig.model ? ` · .rubycode.json loaded` : '') +
    (activeChatId ? ` · chat ${activeChatId}` : ''),
  );

  const cumulative = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  // ── Single task mode: ruby-code "fix the bug" ──────────────────────────────
  if (argv._.length > 0) {
    const task = argv._.join(' ');
    console.log(chalk.hex('#8a7768')(`\n  Task: ${chalk.hex('#ede0cc')(task)}\n`));

    const doOrchestrate = argv.orchestrate === true;

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

    if (result.success) {
      display.summary(result.summary, result.turns, result.toolCallCount);
      printUsageFooter(display, result.usage, result.costUsd);
    } else {
      display.error(result.summary);
      process.exit(1);
    }
    return;
  }

  // ── Interactive REPL mode ──────────────────────────────────────────────────
  if (activeChatHistory.length > 0) {
    console.log(chalk.hex('#8a7768')(`  Continuing session with ${Math.floor(activeChatHistory.length / 2)} prior turns.`));
  }
  console.log(chalk.hex('#8a7768')('  Type a task, or :help for commands. Ctrl+C to exit.\n'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    const idTag = activeChatId ? chalk.hex('#4e3d30')(` [${activeChatId}]`) : '';
    rl.question(chalk.hex('#cc785c')('  ▸ ') + idTag + (idTag ? ' ' : ''), async (line) => {
      const input = line.trim();
      if (!input) { ask(); return; }

      // Slash / colon commands
      const replCtx: ReplCtx = {
        ctx, display,
        providerConfig: { model: resolved.model!, apiKey: runtimeConfig.apiKey, baseUrl: runtimeConfig.baseUrl ?? undefined },
        permissions, cumulative,
        chatState: { projectRoot, activeChatId, activeChatHistory, activeChatTitle, noSession },
      };
      const cmdResult = await handleReplCommand(input, replCtx);
      if (cmdResult.handled) {
        // Commands may update chat state
        if (cmdResult.newChatId !== undefined) activeChatId = cmdResult.newChatId;
        if (cmdResult.newHistory !== undefined) activeChatHistory = cmdResult.newHistory;
        if (cmdResult.newTitle !== undefined) activeChatTitle = cmdResult.newTitle;
        ask();
        return;
      }

      // Run task — pass current conversation history for stay-active mode
      let result;
      try {
        const currentProvider = buildProvider(display);

        const doVerify = argv.verify === true || !!fileConfig.verify;
        if (doVerify) {
          const { runWithVerification } = await import('../verify/index.js');
          const maxRetries = cliMaxVerifyRetries ?? fileConfig.maxVerifyRetries ?? DEFAULTS.maxVerifyRetries;
          const testCommand = cliTestCommand ?? fileConfig.testCommand;
          const wrapperResult = await runWithVerification({
            loopOpts: {
              provider: currentProvider, task: input,
              context: ctx, permissions, display,
              initialHistory: activeChatHistory,
              maxTurns: resolved.maxTurns,
              spawnConfig: {
                apiKey: runtimeConfig.apiKey,
                baseUrl: runtimeConfig.baseUrl ?? undefined,
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
            provider: currentProvider, task: input,
            context: ctx, permissions, display,
            initialHistory: activeChatHistory,
            maxTurns: resolved.maxTurns,
            spawnConfig: {
              apiKey: runtimeConfig.apiKey,
              baseUrl: runtimeConfig.baseUrl ?? undefined,
            },
            sessionPath,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? (err.stack || err.message) : String(err);
        console.error(chalk.hex('#b15439')(`\n  ✗ Unhandled error: ${msg}\n`));
        ask();
        return;
      }

      // Update stay-active history
      activeChatHistory = result.history;

      // Persist session
      if (activeChatId && !noSession) {
        await sessionStore.upsertSession(projectRoot, activeChatId, activeChatHistory, activeChatTitle);
      }

      cumulative.turns += result.turns;
      cumulative.toolCalls += result.toolCallCount;
      cumulative.inputTokens += result.usage.inputTokens;
      cumulative.outputTokens += result.usage.outputTokens;
      cumulative.costUsd += result.costUsd;

      if (result.success) {
        display.summary(result.summary, result.turns, result.toolCallCount);
        printUsageFooter(display, result.usage, result.costUsd);
      } else {
        display.error(result.summary);
      }

      ask();
    });
  };

  // Ctrl+C: if a task is running, prompt to force-quit; second Ctrl+C exits.
  let ctrlC = 0;
  rl.on('SIGINT', () => {
    ctrlC++;
    if (ctrlC === 1) {
      console.log(chalk.hex('#cc785c')('\n  ⏳ Press Ctrl+C again to exit (current task will keep running).'));
      setTimeout(() => { ctrlC = 0; }, 3000);
    } else {
      console.log(chalk.hex('#4e3d30')('\n  BootstrapRuby closed.\n'));
      process.exit(0);
    }
  });

  ask();
  rl.on('close', () => {
    console.log(chalk.hex('#4e3d30')('\n  BootstrapRuby closed.\n'));
    process.exit(0);
  });
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
  ctx: Awaited<ReturnType<typeof loadProjectContext>>;
  display: ReturnType<typeof createTerminalDisplay>;
  providerConfig: { model: string; apiKey?: string; baseUrl?: string };
  permissions: PermissionSystem;
  cumulative: { turns: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
  chatState: ChatState;
}

interface ReplCommandResult {
  handled: boolean;
  newChatId?: string | undefined;
  newHistory?: import('../providers/types.js').HistoryMessage[];
  newTitle?: string | undefined;
}

function trySetModel(c: ReplCtx, newModel: string): { ok: true } | { ok: false; err: string } {
  const prevModel = runtimeConfig.model;
  runtimeConfig.model = newModel;
  try {
    const test = buildProvider(c.display);
    c.providerConfig.model = newModel;
    console.log(chalk.hex('#5a9e6e')(`  ✓ Switched to ${test.name} · ${newModel}`));
    return { ok: true };
  } catch (e) {
    runtimeConfig.model = prevModel;  // rollback on error
    return { ok: false, err: String(e) };
  }
}

/**
 * Interactive model selector — shows all models grouped by provider,
 * lets the user pick by number or type a custom model ID.
 */
function showModelSelector(c: ReplCtx): void {
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(chalk.hex('#cc785c')('  ▸ '), (answer) => {
    const choice = answer.trim();
    rl.close();

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
  });
}

async function handleReplCommand(input: string, c: ReplCtx): Promise<ReplCommandResult> {
  const unhandled: ReplCommandResult = { handled: false };

  if (input === ':quit' || input === ':q' || input === '/exit') {
    process.exit(0);
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
      '  :apikey <key>           Set API key for current session',
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
    showModelSelector(c);
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
    console.log(chalk.hex('#5a9e6e')('  ✓ API key set for current session.'));
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
      `    Est. cost:    $${u.costUsd.toFixed(4)}`,
      '',
    ].join('\n')));
    return { handled: true };
  }

  return unhandled;
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

    // Use a simple readline prompt for confirmation
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const approved = await new Promise<boolean>(resolve => {
      rl.question(chalk.hex('#cc785c')('\n  Run this plan? [y/N] '), answer => {
        rl.close();
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

function printHelp() {
  console.log(`
${chalk.hex('#cc785c').bold('  bootstrapruby')} ${chalk.hex('#8a7768')('— model-agnostic AI coding agent')}

  ${chalk.hex('#4e3d30')('Usage:')}
    bootstrapruby ${chalk.hex('#8a7768')('"<task>"')}                Run a single task
    bootstrapruby ${chalk.hex('#8a7768')('--interactive')}           Start interactive REPL
    bootstrapruby ${chalk.hex('#8a7768')('--models')}                List available models

  ${chalk.hex('#4e3d30')('Options:')}
    --model, -m <id>         Model to use (default: from ~/.config/bootstrapruby/config.json)
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
    --plan                   Preview execution plan before running
    --verify                 Verify output after task; retry up to --max-verify-retries times
    --max-verify-retries <n> Max verification retries (default: 3)
    --test-command <cmd>     Shell command run as part of verification (e.g. "npm test")
    --max-turns <n>          Max agent loop turns before stopping (default: 150)
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

  ${chalk.hex('#4e3d30')('Project config (.rubycode.json):')}
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
    CLI flags always override .rubycode.json.
    Custom providers are OpenAI-compatible endpoints.

  ${chalk.hex('#4e3d30')('Model examples:')}
    bootstrapruby -m claude-opus-4-5-20251001  "refactor auth"
    bootstrapruby -m gpt-4o                    "add unit tests"
    bootstrapruby -m gemini-2.5-pro --rate-limit-rpm 20  "explain this codebase"
    bootstrapruby -m ollama/llama3.2           "local model, no API key needed"

  ${chalk.hex('#4e3d30')('API keys (set as env vars):')}
    ANTHROPIC_API_KEY    Claude models
    OPENAI_API_KEY       GPT models
    GOOGLE_API_KEY       Gemini models
    XAI_API_KEY          Grok models
    OPENROUTER_API_KEY   OpenRouter (access to all models)
    XIAOMI_API_KEY       Xiaomi MiMo
    RUBY_MODEL           Default model (overridden by --model)
    RUBY_API_RPM         Default request rate limit
    RUBY_API_TPM         Default token rate limit (Gemini)
    RUBY_MAX_RETRIES     Default max retry attempts
    RUBY_FALLBACK_MODEL  Comma-separated fallback models
`);
}

if (argv._[0] === 'serve') {
  const port = Number(argv.port ?? argv.p ?? 7337);
  startServer({ port, cwd, model: argv.model, apiKey: argv['api-key'] ?? undefined, baseUrl: argv['base-url'] ?? undefined, open: argv.open !== false }).catch(e => { console.error('Fatal:', String(e)); process.exit(1); });
} else {
  main().catch(e => { console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`)); process.exit(1); });
}

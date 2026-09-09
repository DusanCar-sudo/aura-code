/**
 * The command core — every `:command` that does not need the terminal.
 *
 * These bodies used to live inline in cli/index.ts, which is why the web
 * client could not run any of them. index.ts self-executes: it reads
 * ~/.secrets/agents.env into process.env at import and loads project and
 * global config at module scope, so the engine cannot import it to reach a
 * command implementation, and `web/src/lib/commands.ts` was left answering
 * fifty-two advertised commands with "terminal only".
 *
 * Nothing here runs at import, and everything it touches arrives through
 * `CommandCtx`, so both surfaces call the same code: the REPL passes a
 * terminal context, and the engine's `command.run` passes one built from the
 * protocol session. Output goes through `emit()` (see commands/surface.ts)
 * rather than `console.log`, because on the engine several clients share one
 * stdout and a command's answer belongs only to the client that asked.
 *
 * What deliberately stays in index.ts: `:quit`, `:speak`, `:approve`, the
 * `:model`/`:provider`/`:apikey` selectors and `/context tune`.
 * Each drives the terminal's own stdin or mutates the REPL process's live
 * provider config, and the web client already has real UI for the model and
 * key choices. `:effort` is NOT in that set — the engine owns it per session
 * (`Session.effort`), the same way it owns `:turns`. `unknownCoreCommand()`
 * names the rest so a remote caller is told
 * where they live instead of being handed silence.
 */

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { sessionStore } from '../agent/session-store.js';
import { loadProjectContext, loadGraphSummary } from '../agent/context.js';
import { compactHistory, estimateContextTokens } from '../agent/compactor.js';
import { runAgentLoop } from '../agent/loop.js';
import { SessionBudget } from '../agent/session-budget.js';
import { PermissionSystem } from '../safety/permissions.js';
import { createProvider } from '../providers/factory.js';
import { EFFORT_LEVELS, parseEffort, clampEffort, wasClamped } from '../providers/effort.js';
import { generateDashboard, generateGlobalDashboard, openDashboard } from '../viz/index.js';
import { extractGraph } from '../perception/graphify.js';
import { loadPerception, isStale, extractPerception } from '../perception/index.js';
import { createWorkflow, runWorkflow, resumeWorkflow, listWorkflows, saveWorkflowState } from '../workflows/engine.js';
import type { WorkflowStep, StepResult } from '../workflows/types.js';
import { listBlueprints as listArchitectBlueprints } from '../architect/engine.js';
import { handleSessionCommand, type ReplCommandResult, type ChatState, type ReplMode } from '../cli/repl-session-commands.js';
import { handleModeCommand } from '../cli/repl-mode-commands.js';
import { handleWebCommand } from '../cli/repl-web-command.js';
import { handleCatchCommand } from '../cli/repl-catch-command.js';
import { handleTurnCommand } from '../cli/repl-turn-commands.js';
import { handleComputerCommand } from '../cli/repl-computer-commands.js';
import { handleLessonCommand } from '../cli/repl-lesson-commands.js';
import { handleStudyCommand } from '../cli/repl-study-commands.js';
import { handleCostCommand } from '../cli/repl-cost-command.js';
import { handleArchimedesCommand } from '../cli/repl-archimedes-commands.js';
import { handleUsageCommand } from '../cli/repl-usage-commands.js';
import { handleSkillsCommand } from '../cli/repl-skills-command.js';
import { HELP_TEXT } from '../cli/help-data.js';
import { TEXT_HEX, TEXT_DIM_HEX, FAINT_HEX } from '../cli/diamond.js';
import { ContextHealthTracker } from '../cli/context-health.js';
import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { Display } from '../cli/display.js';
import { envMaxTokens } from '../providers/openai-compatible.js';
import { checkComputerUseGate } from '../tools/screen/disclosure.js';
import { isComputerUseEnabled } from '../tools/computer.js';
import { startRecorder, type RecorderHandle } from '../record/recorder.js';
import { sidecarShots } from '../record/shots.js';
import { runDoctor, formatDoctorReport } from '../doctor/index.js';
import { DEFAULTS } from '../config/defaults.js';
import type { ChildProcess } from 'child_process';
import { emit, type CommandSurface } from './surface.js';

/** Everything a core command needs, and nothing that only a terminal has. */
export interface CommandCtx {
  ctx: Awaited<ReturnType<typeof loadProjectContext>>;
  display: Display;
  providerConfig: { model: string; apiKey?: string; baseUrl?: string; reasoningEffort?: string };
  permissions: PermissionSystem;
  cumulative: { turns: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
  chatState: ChatState;
  sessionPath: string | undefined;
  healthTracker: ContextHealthTracker;
  archimedesOverride: boolean | undefined;
  archimedesModelOverride: string | undefined;
  small1Override: boolean;
  turnsOverride?: number | undefined;
  defaultMaxTurns?: number;
  budget: SessionBudget;
  mode: ReplMode;
  /** Where this command's output goes. See commands/surface.ts. */
  surface: CommandSurface;
  /** Builds a provider for a sub-task (dream, council, btw…). The REPL passes
   *  its own factory so a sub-task inherits the session's live model choice;
   *  the engine passes one built from the protocol session's model. */
  buildProvider: (display: Display, override?: { reasoningEffort?: string; maxTokens?: number }) => LLMProvider;
  /** The effort rung the session is currently sending, for the commands that
   *  deliberately run cheaper than the main loop. */
  effort?: string | undefined;
  /** Ask the human a yes/no question. A surface that cannot ask must pass one
   *  that returns false — never one that returns true. */
  confirm: (message: string) => Promise<boolean>;
  /** :machina's self-verification settings, resolved by the caller from its
   *  flags and .aura.json. */
  verify: { maxRetries?: number; testCommand?: string };
  /** The :catchthis recording in progress, if any — one per surface, held by
   *  the caller because it outlives a single command. */
  catchSession: {
    handle: RecorderHandle | null; startedAt: number; title?: string;
    id?: string; shots?: import('../record/shots.js').ShotTaker;
  };
  /** The web client started by :auraweb, if any. Same reason as above. */
  webServer: { child: ChildProcess | null; url: string | null };
}

/** Commands the core does not own, and where each actually lives. Used to
 *  answer a remote caller honestly instead of falling through to the model. */
export const TERMINAL_ONLY_COMMANDS: Record<string, string> = {
  ':quit': 'ends the terminal process',
  ':speak': 'reads replies aloud through the terminal’s audio',
  ':approve': 'sets the permission level of the terminal session',
  ':model': 'opens an interactive selector — use the model picker here instead',
  ':provider': 'opens an interactive selector — use the model picker here instead',
  ':apikey': 'writes to the key store — use Settings → Provider here instead',
  '/context tune': 'drives the terminal’s shared readline',
  // Archimedes routing is a REPL-loop decision: the engine's turn path runs
  // runAgentLoop directly and never consults the alternator, so accepting
  // these here would confirm a change no turn would honour. `:turns` is not in
  // this list — the engine now carries that cap onto its own loop.
  ':archon': 'routes through the terminal’s Archimedes alternator',
  ':archoff': 'routes through the terminal’s Archimedes alternator',
  ':archmodel': 'routes through the terminal’s Archimedes alternator',
  ':small1': 'routes through the terminal’s Archimedes alternator',
  // These reach into the machine the terminal is running on, not the session.
  ':compon': 'drives the screen and input device of the machine Aura runs on',
  ':compoff': 'drives the screen and input device of the machine Aura runs on',
  ':catchthis': 'records the keyboard of the machine Aura runs on',
  ':auraweb': 'starts this web client — you are already in it',
};

/** True when `input` names a command that only the terminal can run. */
export function isTerminalOnlyCommand(input: string): string | undefined {
  const head = input.trim().toLowerCase();
  if (TERMINAL_ONLY_COMMANDS[head]) return TERMINAL_ONLY_COMMANDS[head];
  const first = head.split(/\s+/)[0];
  return TERMINAL_ONLY_COMMANDS[first];
}

/** The per-task cost line the REPL prints under a completed sub-task. Local
 *  to the core so it reaches the calling surface, not the process's stdout. */
function printUsageFooter(
  _display: Display,
  usage: { inputTokens: number; outputTokens: number },
  costUsd: number,
): void {
  const total = usage.inputTokens + usage.outputTokens;
  emit(chalk.hex(FAINT_HEX)(
    `  ↳ ${total.toLocaleString()} tokens (${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out) · est. $${costUsd.toFixed(4)}`,
  ));
}

export async function runCoreCommand(input: string, c: CommandCtx): Promise<ReplCommandResult> {
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
      emit(chalk.hex('#5a9e6e')(`\n  ✓ Queued #${loadQueue().length}: "${prompt.slice(0, 60)}"\n`));
      return { handled: true };
    }

    if (sub === 'list') {
      const items = loadQueue();
      emit(formatQueue(items));
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
      const result = await runQueueItem(n - 1, c.buildProvider(c.display), c.ctx, c.permissions, c.display);
      if (!result) {
        c.display.warning('Could not run that item.');
        return { handled: true };
      }
      c.display.success(`Queue item #${n}: ${result.success ? 'done' : 'failed'}`);
      if (result.output) {
        emit(chalk.hex(TEXT_HEX)(`  ${result.output.slice(0, 240)}`));
      }
      emit(chalk.hex(FAINT_HEX)(`  ${result.turns} turn(s) · ${result.toolCalls} tool call(s).\n`));
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
      emit(chalk.hex('#5a9e6e')(`\n  ✓ Dropped #${n}: "${removed.prompt.slice(0, 60)}"\n`));
      return { handled: true };
    }

    if (sub === 'clear') {
      const count = loadQueue().length;
      if (count === 0) {
        c.display.warning('Queue is already empty.');
        return { handled: true };
      }
      clearQueue();
      emit(chalk.hex('#5a9e6e')(`\n  ✓ Queue cleared (${count} item(s) removed).\n`));
      return { handled: true };
    }

    c.display.warning('Usage: :q add <prompt> | :q list | :q run <n> | :q drop <n> | :q clear');
    return { handled: true };
  }

  if (input === ':dream' || input === ':dream full') {
    const full = input === ':dream full';
    const { runDream } = await import('../dream/dream.js');
    c.display.agentThinking();
    const res = await runDream({ projectRoot: c.ctx.root, provider: c.buildProvider(c.display), full });
    if (res.skipped) {
      c.display.warning(res.providerError
        ? `Dream skipped (episodes preserved): ${res.providerError}`
        : (res.reason ?? 'Nothing to consolidate.'));
    } else {
      c.display.success(`Dream written: ${res.path} (${res.episodeCount} episodes${full ? ', full run' : ''})`);
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
    emit(chalk.hex(TEXT_DIM_HEX)(`\n  Researching "${topic}"…\n`));
    try {
      const { runResearch } = await import('../research/research.js');
      const res = await runResearch({
        projectRoot: c.ctx.root,
        topic,
        provider: c.buildProvider(c.display),
        context: c.ctx,
        permissions: c.permissions,
        display: c.display,
      });
      emit(chalk.hex('#5a9e6e')(`  ✓ Research written: ${res.path}`));
      emit(chalk.hex(TEXT_DIM_HEX)(`  ${res.turns} turn(s) · ${res.toolCalls} tool call(s).\n`));
    } catch (e) {
      emit(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }

  // ── :designx — design commission (routes a style direction, scrapes real
  // references, then builds the artefact). See src/design/ for the lexicon and
  // the reasoning behind routing before generating.
  if (input === ':designx' || input.startsWith(':designx ')) {
    const { parseDesignXArgs } = await import('../design/parse.js');
    const dxArgs = parseDesignXArgs(input.slice(':designx'.length));

    if (dxArgs.listStyles) {
      const { DESIGN_STYLES } = await import('../design/styles.js');
      emit(chalk.hex('#cc785c').bold(`\n  Design lexicon — ${DESIGN_STYLES.length} directions\n`));
      for (const s of DESIGN_STYLES) {
        emit(`  ${chalk.hex(TEXT_HEX).bold(s.name)} ${chalk.hex(FAINT_HEX)(`(${s.id})`)}`);
        emit(chalk.hex(TEXT_DIM_HEX)(`    risk ${s.risk}/5 · ${s.fits.join(', ')} · ${s.lineage}`));
      }
      emit(chalk.hex(FAINT_HEX)('\n  Pin one with :designx <brief> --style <id>\n'));
      return { handled: true };
    }

    if (!dxArgs.brief) {
      c.display.warning('Usage: :designx [web|deck|pdf] <brief> [--wild|--feral|--classic] [--style <id>] [--seed <n>] [--no-scrape] [--out <dir>]');
      c.display.warning('       :designx styles   — list the design lexicon');
      return { handled: true };
    }

    const { routeStyles } = await import('../design/styles.js');
    const previewStyles = routeStyles({
      brief: dxArgs.brief, target: dxArgs.target, daring: dxArgs.daring,
      pinned: dxArgs.pinned, seed: dxArgs.seed, count: dxArgs.count,
    });
    emit(chalk.hex('#cc785c').bold(`\n  ✦ designx — ${dxArgs.target}${dxArgs.targetInferred ? chalk.hex(FAINT_HEX)(' (inferred)') : ''} · ${dxArgs.daring}`));
    for (const s of previewStyles) {
      emit(chalk.hex(TEXT_HEX)(`    ▸ ${s.name}`) + chalk.hex(FAINT_HEX)(`  risk ${s.risk}/5`));
    }
    emit(chalk.hex(TEXT_DIM_HEX)(`    ${dxArgs.scrape ? 'Scraping references, then building' : 'No research pass'}…\n`));

    try {
      const { runDesignX } = await import('../design/designx.js');
      const dx = await runDesignX({
        projectRoot: c.ctx.root,
        args: dxArgs,
        // Explicit budget for the artefact, so :designx works without the user
        // having to know about AURA_MAX_TOKENS / --effort. An env-set ceiling
        // still wins if it is higher.
        provider: c.buildProvider(c.display, {
          maxTokens: Math.max(60_000, envMaxTokens() ?? 0),
          reasoningEffort: c.effort ?? 'low',
        }),
        context: c.ctx,
        permissions: c.permissions,
        display: c.display,
      });
      if (dx.files.length === 0) {
        c.display.error('designx produced no files — see the agent output above.');
      } else if (dx.problems.length > 0) {
        // Files exist but are not finished — the placeholder-skeleton failure.
        // Reported as an error rather than a success with a caveat, because the
        // directory listing alone looks exactly like a completed run.
        c.display.error(`designx wrote ${dx.files.length} file(s) but they are not finished:`);
        for (const p of dx.problems) emit(chalk.hex('#b15439')(`    ${p.file}: ${p.problem}`));
        emit(chalk.hex(TEXT_DIM_HEX)(`  ${dx.dir}`));
        emit(chalk.hex(FAINT_HEX)('  Re-run to have it rebuild them in a single write.\n'));
      } else {
        emit(chalk.hex('#5a9e6e')(`\n  ✓ ${dx.dir}`));
        for (const f of dx.files) emit(chalk.hex(TEXT_DIM_HEX)(`    ${f}`));
        emit(chalk.hex(FAINT_HEX)(`  ${dx.turns} turn(s) · ${dx.toolCalls} tool call(s) · led with ${dx.styles[0]?.name ?? 'no direction'}`));
        emit(chalk.hex(FAINT_HEX)(`  Re-roll: :designx ${dxArgs.brief} --seed ${(dxArgs.seed ?? 0) + 1}\n`));
      }
    } catch (e) {
      emit(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }
  if (input === ':confessions') {
    const { listConfessions } = await import('../agent/confess.js');
    const confs = listConfessions();
    if (confs.length === 0) {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No confessions yet. Run :confess after a high-token episode.\n'));
    } else {
      emit(chalk.hex('#cc785c').bold(`\n  ${confs.length} confession(s):\n`));
      for (const c of confs) {
        emit(chalk.hex(TEXT_DIM_HEX)(`  ${c.file}`));
        emit(chalk.hex(FAINT_HEX)(`    ${c.tokens.toLocaleString()} tokens burned → ${c.lesson.slice(0, 100)}`));
      }
      emit('');
    }
    return { handled: true };
  }
  if (input === ':confess') {
    const { runConfession, findEpisodeToConfess } = await import('../agent/confess.js');
    const targetEp = findEpisodeToConfess(c.ctx.root);
    if (!targetEp) {
      emit(chalk.hex('#cc9e5c')('\n  No anomalous episode found. Confession is fully automatic — the system alone decides what to confess.\n'));
      return { handled: true };
    }
    emit(chalk.hex(TEXT_DIM_HEX)(`\n  🙏 Confessing episode ${targetEp.id.slice(0,8)}… — ${targetEp.task.slice(0,60)} (${(targetEp.tokens/1e6).toFixed(1)}M tok)\n`));
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
      emit(chalk.hex('#5a9e6e')(`  ✓ Confession written: ${result.path}`));
      emit(chalk.hex(TEXT_DIM_HEX)(`  Tokens burned: ${result.tokensBurned.toLocaleString()} | Confession cost: ${result.tokensSpent.toLocaleString()} (${confessorModel})`));
      emit(chalk.hex('#cc9e6c')('  Permanent lesson:'));
      emit(chalk.hex(TEXT_HEX)(`  "${result.lesson}"\n`));
    } catch (e) {
      emit(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }
  if (input === ':rem') {
    const { getReconciledOrLatest } = await import('../dream/dream.js');
    const res = getReconciledOrLatest(c.ctx.root);
    if (!res) {
      c.display.warning('No dreams yet. Run :dream first.');
    } else {
      emit(chalk.hex(TEXT_DIM_HEX)(`\n  ${res.isReconciled ? 'Reconciled projection' : 'Latest dream (not yet reconciled)'}:\n`));
      emit(res.content);
    }
    return { handled: true };
  }
  // ── :mine — Baby Archimedes experience mining (src/mining/). The base pass is
  // zero-LLM (pure clustering over episodes/*.json); --refine additionally
  // runs Papa Archimedes, one local-model call per qualifying concept, appending
  // accepted lessons to training-data/<date>.jsonl; --corrections emits direct
  // correction pairs (Path B) from escalation episodes; --stats shows row counts
  // by provenance.
  if (input === ':mine' || input.startsWith(':mine ')) {
    const refine = input.includes('--refine');
    const corrections = input.includes('--corrections');
    const stats = input.includes('--stats');
    if (!refine && !corrections && !stats) {
      c.display.warning('Usage: :mine [--refine] [--corrections] [--stats] — base pass mines concepts; --refine judges them with the local model; --corrections writes direct correction pairs; --stats reports the training-data corpus by provenance.');
      return { handled: true };
    }
    // --stats / --corrections work on their own; the base mine pass (concept
    // listing + --refine) is only needed when the user asks for it.
    if (stats) {
      const { trainingDataStats } = await import('../mining/corpus.js');
      const s = trainingDataStats(c.ctx.root);
      if (s.total === 0) {
        c.display.warning('No training-data rows yet — run :mine --refine or :mine --corrections to produce them.');
      } else {
        emit(chalk.hex('#cc785c').bold(`\n  Training-data corpus (${s.total} row(s)):\n`));
        for (const [prov, n] of Object.entries(s.byProvenance)) {
          emit(chalk.hex(TEXT_DIM_HEX)(`    ${prov.padEnd(12)} ${n}`));
        }
      }
    }
    if (corrections) {
      const { collectCorrections } = await import('../mining/corrections.js');
      emit(chalk.hex(TEXT_DIM_HEX)('\n  Collecting direct correction pairs from escalation episodes…'));
      const res = await collectCorrections(c.ctx.root);
      if (res.written.length > 0) {
        emit(chalk.hex('#5a9e6e')(`  ✓ ${res.written.length} correction pair(s) appended: ${res.outputPath}`));
        emit(chalk.hex(FAINT_HEX)(`    ${res.skipped} episode(s) skipped (not escalations).\n`));
      } else {
        c.display.warning(`No correction pairs — ${res.skipped} episode(s) skipped (not escalations).`);
      }
    }
    if (refine) {
      const { mineExperience } = await import('../mining/extract.js');
      const mined = await mineExperience(c.ctx.root);
      if (mined.episodeCount === 0) {
        c.display.warning('No episodes to mine yet — run some tasks first.');
        return { handled: true };
      }
      emit(chalk.hex('#cc785c').bold(`\n  Mined ${mined.concepts.length} concept(s) from ${mined.episodeCount} episode(s) (${mined.unclustered} unclustered):\n`));
      for (const con of mined.concepts.slice(0, 15)) {
        emit(chalk.hex(TEXT_DIM_HEX)(`  ${con.concept}`) + chalk.hex(FAINT_HEX)(`  (${con.category} · ×${con.frequency} · conf ${con.confidence} · depth ${con.depth})`));
        if (con.keywords.length > 0) emit(chalk.hex(FAINT_HEX)(`    keywords: ${con.keywords.join(', ')}`));
      }
      if (mined.concepts.length > 15) {
        emit(chalk.hex(FAINT_HEX)(`  … and ${mined.concepts.length - 15} more.`));
      }
      emit(chalk.hex(TEXT_DIM_HEX)('\n  Refining with the local Archimedes model (Papa Archimedes)…'));
      const { refineConcepts } = await import('../mining/refine.js');
      const res = await refineConcepts({ projectRoot: c.ctx.root, concepts: mined.concepts });
      if (res.accepted.length > 0) {
        emit(chalk.hex('#5a9e6e')(`  ✓ ${res.accepted.length} training example(s) appended: ${res.outputPath}`));
        emit(chalk.hex(FAINT_HEX)(`    ${res.rejected} rejected, ${res.skipped} below the confidence/frequency gate.\n`));
      } else {
        c.display.warning(`No concepts survived refinement — ${res.rejected} rejected, ${res.skipped} below the confidence/frequency gate.`);
      }
    }
    return { handled: true };
  }

  if (input === ':doctor' || input.startsWith(':doctor')) {
    const fix = input.includes('--fix');
    const offline = input.includes('--offline');
    c.display.agentThinking();
    const report = await runDoctor({ projectRoot: c.ctx.root, fix, offline });
    if (true) {
      emit(formatDoctorReport(report));
    } else {
      emit(formatDoctorReport(report));
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
    const maxRetries = c.verify.maxRetries ?? DEFAULTS.maxVerifyRetries;
    const testCommand = c.verify.testCommand;
    const wrapperResult = await runWithVerification({
      loopOpts: {
        provider: c.buildProvider(c.display), task: machinaTask,
        context: c.ctx, permissions: c.permissions, display: c.display,
        initialHistory: c.chatState.activeChatHistory,
        maxTurns: c.defaultMaxTurns,
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
      provider: c.buildProvider(c.display), task: councilTask, context: c.ctx, display: c.display,
    });
    if (councilResult.success) {
      c.display.summary(councilResult.summary, councilResult.turns, councilResult.toolCallCount);
      printUsageFooter(c.display, councilResult.usage, councilResult.costUsd);
    } else {
      c.display.error(councilResult.summary);
    }
    return { handled: true };
  }
  // ── :ecclesia — 5-agent independent research council (research/council.ts).
  // Distinct from :council above (mixture-of-agents over the current task):
  // the Ecclesia runs N agents that research a topic WITHOUT seeing each
  // other's findings, then one synthesis call reconciles them into a verdict.
  if (input.startsWith(':ecclesia ') || input === ':ecclesia') {
    let topic = input.slice(':ecclesia '.length).trim();
    if (!topic) {
      c.display.warning('Usage: :ecclesia <topic> [--panel <model>] [--seats <n>] -- N independent research agents (default 5) + a synthesis verdict, saved to council/*.md|.html.');
      return { handled: true };
    }
    let panelModel: string | undefined;
    let panelSize: number | undefined;
    const panelMatch = topic.match(/\s--panel\s+(\S+)/);
    if (panelMatch) { panelModel = panelMatch[1]; topic = topic.replace(panelMatch[0], '').trim(); }
    const seatsMatch = topic.match(/\s--seats\s+(\d+)/);
    if (seatsMatch) { panelSize = Number(seatsMatch[1]); topic = topic.replace(seatsMatch[0], '').trim(); }
    emit(chalk.hex(TEXT_DIM_HEX)(`\n  Convening the Ecclesia on "${topic}"…\n`));
    try {
      const { runCouncil } = await import('../research/council.js');
      const res = await runCouncil({
        projectRoot: c.ctx.root, topic,
        synthesisProvider: c.buildProvider(c.display),
        context: c.ctx, permissions: c.permissions, display: c.display,
        panelSize, panelModel,
        configuredModel: c.providerConfig.model,
      });
      emit(chalk.hex('#5a9e6e')(`  ✓ Ecclesia verdict written: ${res.path}`));
      emit(chalk.hex('#5a9e6e')(`    HTML: ${res.htmlPath}`));
      emit(chalk.hex(TEXT_DIM_HEX)(`  ${res.panelSize} seats on ${res.panelModel}.`));
      if (res.agentFailures > 0) {
        c.display.warning(`${res.agentFailures} of ${res.panelSize} panel agent(s) failed — verdict is based on the rest.`);
      }
    } catch (e) {
      emit(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }

  // ── :nerds — one writer at a time, readers unrestricted ─────────────────
  if (input === ':nerds' || input.startsWith(':nerds ')) {
    const { NerdsPolicy } = await import('../orchestration/nerds.js');
    const arg = input.slice(':nerds'.length).trim();

    if (arg === 'off') {
      NerdsPolicy.disable();
      emit(chalk.hex(TEXT_DIM_HEX)('\n  Nerds off — parallel tasks write without coordination again.\n'));
      return { handled: true };
    }

    if (arg === 'status') {
      const st = NerdsPolicy.getState();
      emit(st.enabled
        ? chalk.hex('#6ed0ea')(`\n  Nerds on — writer: ${st.holder ?? 'none'}${st.waiting.length ? `, waiting: ${st.waiting.join(', ')}` : ''}\n`)
        : chalk.hex(TEXT_DIM_HEX)('\n  Nerds off.\n'));
      return { handled: true };
    }

    NerdsPolicy.enable();
    emit(chalk.hex('#6ed0ea').bold('\n  🤓 Nerds on'));
    emit(chalk.hex(TEXT_DIM_HEX)('  Read-only work runs in parallel; only one writer at a time, the rest queue.'));
    emit(chalk.hex(TEXT_DIM_HEX)("  The lease is live — board runs do not consult it yet. ':nerds off' ends it.\n"));

    if (arg) {
      return { handled: true, runTask: arg };
    }
    return { handled: true };
  }

  // ── :marathon — long-haul flag, with the task it was given ──────────────
  //
  // The banner says only what the code does. It used to announce a
  // coordination loop, exponential backoffs and a context compactor; none of
  // those were wired to anything, and an operator who believes a banner is an
  // operator who debugs the difference later.
  if (input === ':marathon' || input.startsWith(':marathon ')) {
    const { MarathonManager, formatRemaining } = await import('../orchestration/marathon.js');
    const arg = input.slice(':marathon'.length).trim();

    if (arg === 'off') {
      MarathonManager.deactivate();
      emit(chalk.hex(TEXT_DIM_HEX)('\n  Marathon mode off.\n'));
      return { handled: true };
    }

    if (arg === 'status') {
      const st = MarathonManager.getState();
      emit(st.enabled
        ? chalk.hex('#6ed0ea')(`\n  Marathon mode on — ${formatRemaining(st.remainingMs)} left.\n`)
        : chalk.hex(TEXT_DIM_HEX)('\n  Marathon mode off.\n'));
      return { handled: true };
    }

    MarathonManager.activate();
    const { remainingMs } = MarathonManager.getState();
    emit(chalk.hex('#6ed0ea').bold('\n  🏃 Marathon mode on'));
    emit(chalk.hex(TEXT_DIM_HEX)(`  Lapses on its own in ${formatRemaining(remainingMs)}. ':marathon off' ends it sooner.`));
    emit(chalk.hex(TEXT_DIM_HEX)('  It is a flag: nothing in the run loop reads it yet, so turns behave as usual.\n'));

    if (arg) {
      return { handled: true, runTask: arg };
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
    const result = await runBtwQuery(question, c.buildProvider(c.display), c.ctx);
    emit(renderBtwAnswer(result.answer, result.tokens));
    return { handled: true };
  }

  // ── Archimedes routing ───────────────────────────────────────────────────
  // :small1, :archon, :archoff, :archmodel. In repl-archimedes-commands.ts so
  // they can be tested without importing this self-executing module — each one
  // only returns an override flag, and a dropped return looks identical to a
  // working command from the outside. Called from the exact position those
  // branches occupied.
  const archCmd = await handleArchimedesCommand(input, {
    projectRoot: c.ctx.root,
    archimedesModelOverride: c.archimedesModelOverride,
    display: c.display,
  });
  if (archCmd) return archCmd;

  // ── Skills ───────────────────────────────────────────────────────────────
  // :skills reports the parsed catalog the agent routes against — see
  // repl-skills-command.ts for why an installed skill is otherwise
  // indistinguishable from a loaded one.
  const skillsCmd = handleSkillsCommand(input, { projectRoot: c.ctx.root });
  if (skillsCmd) return skillsCmd;

  if (input === ':help' || input === '/help') {
    emit(chalk.hex(TEXT_DIM_HEX)(HELP_TEXT.join('\n')));
    return { handled: true };
  }

  // :stop / :cancel while a task runs never reach here — the REPL's onEnter
  // intercepts them against the live abortController (see setCallbacks in
  // index.ts). This branch is the idle case: the help text advertises both
  // spellings unconditionally, so typing one between tasks must answer as a
  // command, not fall through to "Unknown command".
  if (input === ':stop' || input === ':cancel') {
    emit(chalk.hex(TEXT_DIM_HEX)('  Nothing is running — :stop/:cancel abort a running task.'));
    return { handled: true };
  }

  // ── Turn limit commands (:turnsoff, :turnson, :turns [n|off|on]) ─────────
  {
    const turnResult = handleTurnCommand(input, {
      turnsOverride: c.turnsOverride,
      defaultMaxTurns: c.defaultMaxTurns,
      display: c.display,
    });
    if (turnResult) return turnResult;
  }

  // ── What Aura has learned (:lessons, :forget) ───────────────────────────
  // The gap loop writes into the system prompt; these are how a human reads
  // and corrects it. See repl-lesson-commands.ts.
  {
    const lessonResult = handleLessonCommand(input, {
      display: c.display,
      write: (text: string) => emit(text),
      projectRoot: c.ctx.root,
    });
    if (lessonResult) return lessonResult;
  }

  // ── Topic packs (:study, :learn, :unlearn) ─────────────────────────────
  // Curated per-subject facts. Pinned topics are injected into the system
  // prompt; everything else stays reachable through memory search.
  {
    const studyResult = handleStudyCommand(input, {
      display: c.display,
      write: (text: string) => emit(text),
    });
    if (studyResult) return studyResult;
  }

  // ── Cost ledger (:cost) ────────────────────────────────────────────────
  // Every Archimedes-path attempt appends a row to ~/.aura/cost-log/;
  // this reads it back and reports whether small-first actually saves.
  {
    const costResult = await handleCostCommand(input);
    if (costResult) return costResult;
  }

  // ── Computer use (:compon, :compoff, :comp) ─────────────────────────────
  // Placed with the other toggles and, like them, reachable only from a
  // keystroke — see repl-computer-commands.ts on why an in-session switch is
  // a third key of equal strength rather than a way around the two-key gate.
  {
    const compResult = await handleComputerCommand(input, {
      display: c.display,
      confirm: (message: string) => c.confirm(message),
      write: (text: string) => emit(text),
    });
    if (compResult) return compResult;
  }

  // ── :catchthis ───────────────────────────────────────────────────────────
  // Demonstrate a job once, get it back as a repeatable task. Records the
  // keyboard at the kernel level, so the command says so every time it starts —
  // see repl-catch-command.ts.
  {
    let caughtTask: string | undefined;
    const computerUseAllowed = checkComputerUseGate(isComputerUseEnabled()).allowed;
    const caught = await handleCatchCommand(input, {
      print: (line: string) => emit(chalk.hex(TEXT_DIM_HEX)(line)),
      session: c.catchSession,
      start: (o) => startRecorder(o),
      // Photographing the screen goes through the same gate as moving the
      // pointer: a click screenshot is exactly the disclosure computer use
      // exists to make, so recording one without it would route around it.
      shotsFor: computerUseAllowed ? (dir: string) => sidecarShots(dir) : undefined,
      // Replay drives the real pointer, so it goes through the same gate as
      // any other computer use rather than inventing a second way in.
      run: computerUseAllowed ? (prompt: string) => { caughtTask = prompt; } : undefined,
    });
    if (caught) return { handled: true, runTask: caughtTask } as ReplCommandResult;
  }

  // ── Web client ───────────────────────────────────────────────────────────
  // :auraweb brings up the browser surface without leaving the TUI. The server
  // is a child of this process, so it dies with the terminal rather than
  // stranding a port and a session token behind it.
  {
    const webResult = handleWebCommand(input, {
      print: (line: string) => emit(chalk.hex(TEXT_DIM_HEX)(line)),
      server: c.webServer,
    });
    if (webResult) return { handled: true } as ReplCommandResult;
  }

  // ── Modes ────────────────────────────────────────────────────────────────
  // :coder / :gazelle. The REPL owns the switch itself (see enterMode); these
  // only report the intent. In repl-mode-commands.ts so they can be tested —
  // being unreachable from a test is how they stayed advertised-but-unhandled.
  {
    const modeResult = handleModeCommand(input, { mode: c.mode, display: c.display });
    if (modeResult) return modeResult;
  }

  // ── Session commands ─────────────────────────────────────────────────────

  // :effort reads and sets this session's reasoning-effort rung. The caller
  // carries newEffort back onto the session and the next per-turn provider
  // build sends it — the same live-apply contract as the TUI's :effort, which
  // mutates its runtimeConfig directly and stays in index.ts.
  if (input === ':effort' || input === '/effort'
      || input.startsWith(':effort ') || input.startsWith('/effort ')) {
    const arg = input.replace(/^[:/]effort\s*/, '').trim();
    const target = { model: c.providerConfig.model, baseUrl: c.providerConfig.baseUrl };
    if (!arg) {
      const cur = parseEffort(c.effort);
      const sent = cur ? clampEffort(cur, target) : undefined;
      emit(chalk.hex(TEXT_DIM_HEX)(
        `  effort: ${cur ?? 'provider default'}`
        + (cur && sent !== cur ? chalk.hex('#d4903a')(`  (sent as "${sent}" — ${c.providerConfig.model} tops out there)`) : '')
        + `\n  ladder: ${EFFORT_LEVELS.join(' · ')}`
        + `\n  usage:  :effort <level>`));
      return { handled: true };
    }
    const level = parseEffort(arg);
    if (!level) {
      emit(chalk.hex('#b15439')(
        `  ✗ Unknown effort "${arg}". Expected one of: ${EFFORT_LEVELS.join(', ')}`));
      return { handled: true };
    }
    emit(chalk.hex('#5a9e6e')(`  ✓ Effort: ${level} — live from the next task.`)
      + (wasClamped(level, target)
        ? chalk.hex('#d4903a')(` Sent as "${clampEffort(level, target)}", the ceiling for ${c.providerConfig.model}.`)
        : ''));
    if (level === 'none') {
      emit(chalk.hex(TEXT_DIM_HEX)('  Thinking disabled — the model answers without a chain of thought.'));
    }
    return { handled: true, newEffort: level };
  }

  if (input === ':id') {
    const cs = c.chatState;
    if (cs.activeChatId) {
      emit(chalk.hex(TEXT_DIM_HEX)(`\n  Chat ID: ${chalk.hex('#cc785c')(cs.activeChatId)}`));
      if (cs.activeChatTitle) emit(chalk.hex(TEXT_DIM_HEX)(`  Title:   ${cs.activeChatTitle}`));
      emit(chalk.hex(FAINT_HEX)(`  Turns:   ${Math.floor(cs.activeChatHistory.length / 2)}\n`));
    } else {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No active session (--no-session mode).\n'));
    }
    return { handled: true };
  }

  if (input === ':sessions' || input === ':sessions all' || input === ':sessions --all'
      || input === ':sessions here') {
    // One merged list across every project by default — the same list the web
    // client shows. `:sessions here` narrows to the current directory.
    const hereOnly = input === ':sessions here';
    const all = sessionStore.listAllSessions();
    const thisRoot = path.resolve(c.chatState.projectRoot);
    const sessions = hereOnly ? all.filter(s => path.resolve(s.projectRoot) === thisRoot) : all;
    if (sessions.length === 0) {
      emit(chalk.hex(TEXT_DIM_HEX)(
        hereOnly ? '\n  No saved sessions in this project.\n' : '\n  No saved sessions anywhere.\n',
      ));
    } else {
      const otherProjects = new Set(sessions.map(s => s.project)).size;
      emit(chalk.hex('#cc785c').bold(
        hereOnly ? '\n  Saved sessions (this project):\n'
                 : `\n  Saved sessions (${sessions.length} across ${otherProjects} project${otherProjects === 1 ? '' : 's'}):\n`,
      ));
      // One TUI page, not the whole store. The TUI's scroll region is
      // screenRows minus the fixed bottom block (7) and the compact banner
      // (4), and this command's own frame (title, hint, blanks) costs 4 more —
      // so the list gets rows-15, floored for tiny/non-TTY stdout. listAllSessions()
      // is newest-first, so the newest page is the one shown.
      const pageRows = Math.max(10, (process.stdout.rows ?? 24) - 15);
      const shown = sessions.slice(0, pageRows);
      const hidden = sessions.length - shown.length;
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i];
        const num = chalk.hex(TEXT_DIM_HEX)(`[#${i + 1}]`.padEnd(5));
        const updated = new Date(s.updatedAt).toLocaleString();
        const turns = Math.floor(s.history.length / 2);
        const marker = s.id === c.chatState.activeChatId ? chalk.hex('#5a9e6e')(' ← current') : '';
        const here = path.resolve(s.projectRoot) === thisRoot;
        const label = (path.basename(s.projectRoot) || s.projectRoot).replace(/^_+/, '').slice(0, 24);
        const proj = hereOnly || here ? '' : chalk.hex(FAINT_HEX)(` · ${label}`);
        emit(
          `  ${num} ${chalk.hex('#cc785c')(s.id.padEnd(20))} ` +
          `${chalk.hex(TEXT_HEX)(s.title.slice(0, 36).padEnd(37))} ` +
          `${chalk.hex(FAINT_HEX)(`${turns}t · ${updated}`)}${proj}${marker}`,
        );
      }
      if (hidden > 0) {
        // Numbering (#N) only covers what is on screen — it indexes the same
        // newest-first list this page was sliced from — so anything past the
        // page must be reached by id, not by number.
        emit(chalk.hex(TEXT_DIM_HEX)(
          `  … ${hidden} older session${hidden === 1 ? '' : 's'} not shown — :resume/:delete by id still reach them.`,
        ));
      }
      emit(chalk.hex(TEXT_DIM_HEX)('\n  Resume any with :resume <id>.'
        + (hereOnly ? '' : '  ·  :sessions here for this project only.')));
      emit('');
    }
    return { handled: true };
  }

  // Session/history commands (:resume, :resume <id>, :new, :history,
  // :clear-history, :save, :delete) live in repl-session-commands.ts so they
  // can be tested without importing this self-executing module. Called from
  // the exact position those branches occupied — moving this call earlier
  // would let them shadow commands declared above.
  const sessionCmd = await handleSessionCommand(input, c);
  if (sessionCmd) return sessionCmd;

  // ── Model / API commands ─────────────────────────────────────────────────

  if (input === ':compact' || input === ':compress') {
    const { compactHistory, estimateContextTokens, getRecapGeneration } = await import('../agent/compactor.js');
    const { getContextWindow } = await import('../providers/factory.js');
    const history = c.chatState.activeChatHistory;
    if (history.length <= 1) {
      emit(chalk.hex('#d4903a')('\n  Nothing to compact — history is empty or has only the task.\n'));
      return { handled: true };
    }
    const model = c.providerConfig.model;
    const beforeTokens = estimateContextTokens('', history);
    const window = getContextWindow(model) ?? 128_000;
    const generation = getRecapGeneration(history);
    // Force compaction by passing totalTokens = Infinity so the threshold check is bypassed.
    const compacted = compactHistory(history, Infinity, model);
    if (!compacted) {
      emit(chalk.hex('#d4903a')('\n  Compaction had no effect — history is already minimal.\n'));
      return { handled: true };
    }
    const afterTokens = estimateContextTokens('', history);
    const saved = beforeTokens > 0 ? ((1 - afterTokens / beforeTokens) * 100).toFixed(0) : '0';
    const newGen = getRecapGeneration(history);
    emit(chalk.hex('#5a9e6e')(
      `\n  ✓ Context compacted: ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens ` +
      chalk.hex('#5a9e6e')(`(-${saved}%)`) +
      ` · gen ${generation}→${newGen} · window ${(window / 1000).toFixed(0)}k\n`,
    ));
    c.healthTracker.recordCompaction(beforeTokens, afterTokens, newGen);
    return { handled: true, newHistory: [...history] };
  }

  if (input === ':context') {
    emit(chalk.hex(TEXT_DIM_HEX)(`\n  Project: ${c.ctx.name} · ${c.ctx.language} · ${c.ctx.framework}`));
    emit(chalk.hex(FAINT_HEX)(`  Root: ${c.ctx.root}\n`));
    return { handled: true };
  }

  if (input === ':graph') {
    const summary = loadGraphSummary(c.ctx.root);
    if (!summary) {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No graph.json found. Run :graph extract to build it.\n'));
    } else {
      emit(chalk.hex('#cc785c').bold('\n  Codebase Knowledge Graph\n'));
      emit(chalk.hex(TEXT_DIM_HEX)(summary));
      emit('');
    }
    return { handled: true };
  }

  if (input === ':viz' || input === ':dashboard'
      || input === ':viz all' || input === ':dashboard all') {
    const all = input.endsWith(' all');
    emit(chalk.hex(TEXT_DIM_HEX)(
      all ? '\n  Harvesting every project with a graph…\n' : '\n  Generating dashboard…\n',
    ));
    try {
      const outPath = all ? generateGlobalDashboard() : generateDashboard(c.ctx.root);
      emit(chalk.hex('#5a9e6e')(`  ✓ Dashboard written to ${outPath}`));
      emit(chalk.hex(TEXT_DIM_HEX)('  Opening in browser…\n'));
      openDashboard(outPath);
    } catch (e) {
      emit(chalk.hex('#b15439')(`  ✗ ${String(e)}\n`));
    }
    return { handled: true };
  }

  if (input === ':plans') {
    const { planStore } = await import('../orchestration/plan-store.js');
    const plans = await planStore.list();
    if (!plans.length) {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No execution plans found.\n'));
    } else {
      emit(chalk.hex('#cc785c').bold('\n  Execution plans:\n'));
      for (const p of plans.slice(0, 15)) {
        const created = new Date(p.created).toLocaleString();
        const dur = p.completed ? `${Math.round((p.completed - p.created) / 1000)}s` : '—';
        const statusColor = p.status === 'done' ? '#5a9e6e' : p.status === 'failed' ? '#b15439' : '#cc9e5c';
        emit(
          `  ${chalk.hex(statusColor)(p.status.padEnd(8))} ` +
          `${chalk.hex('#cc785c')(p.id.slice(0, 12).padEnd(14))} ` +
          `${chalk.hex(TEXT_HEX)(p.goal.slice(0, 50).padEnd(51))} ` +
          `${chalk.hex(FAINT_HEX)(`${p.steps.length}s · ${dur} · ${created}`)}`,
        );
      }
      emit('');
    }
    return { handled: true };
  }

  if (input === ':graph extract' || input === ':graph refresh') {
    const action = input === ':graph extract' ? 'Extracting' : 'Refreshing';
    emit(chalk.hex(TEXT_DIM_HEX)(`\n  ${action} codebase graph…\n`));
    try {
      const outPath = await extractGraph(c.ctx.root);
      emit(chalk.hex('#5a9e6e')(`  ✓ Graph written to ${outPath}`));
      // Reload context graph so :graph and the agent loop see it immediately
      c.ctx.graphSummary = loadGraphSummary(c.ctx.root);
      if (c.ctx.graphSummary) {
        const n = c.ctx.graphSummary.match(/Top (\d+) of (\d+) nodes/);
        const counts = n ? `${n[1]}/${n[2]} nodes` : '';
        emit(chalk.hex('#5a9e6e')(`  ✓ Injected into context (${counts}).\n`));
      } else {
        emit(chalk.hex(TEXT_DIM_HEX)('  Graph saved but could not be loaded into context.\n'));
      }
    } catch (e) {
      emit(chalk.hex('#b15439')(`  ✗ Extraction failed: ${String(e)}\n`));
    }
    return { handled: true };
  }

  // ── Usage reporting ──────────────────────────────────────────────────────
  // /clear, /stats, /context, /cost — the commands that only read or reset the
  // counters, never the history. In repl-usage-commands.ts so they can be
  // tested without importing this self-executing module. /context tune stays
  // below: it drives the shared readline, which is this loop's state.
  const usageCmd = await handleUsageCommand(input, {
    projectRoot: c.ctx.root,
    cumulative: c.cumulative,
    healthTracker: c.healthTracker,
    display: c.display,
    model: c.providerConfig.model,
  });
  if (usageCmd) return usageCmd;

  // ── Workflow commands ──────────────────────────────────────────────────────

  if (input === ':workflows') {
    const workflows = await listWorkflows();
    if (workflows.length === 0) {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No saved workflows.\n'));
    } else {
      emit(chalk.hex('#cc785c').bold('\n  Saved workflows:\n'));
      for (const ws of workflows) {
        const created = new Date(ws.definition.createdAt).toLocaleString();
        const doneSteps = ws.stepStates.filter(s => s.status === 'done').length;
        const totalSteps = ws.definition.steps.length;
        const statusColor = ws.status === 'done' ? '#5a9e6e' : ws.status === 'failed' ? '#b15439' : '#cc785c';
        emit(
          `  ${chalk.hex('#cc785c')(ws.definition.id.padEnd(24))} ` +
          `${chalk.hex(TEXT_HEX)(ws.definition.name.slice(0, 36).padEnd(37))} ` +
          `${chalk.hex(statusColor)(ws.status.padEnd(8))} ` +
          `${chalk.hex(FAINT_HEX)(`${doneSteps}/${totalSteps} steps · ${created}`)}`,
        );
      }
      emit('');
    }
    return { handled: true };
  }

  if (input.startsWith(':workflow ')) {
    const parts = input.slice(':workflow '.length).trim();
    // Parse: <name> "step1" "step2" ...  or  <name> step1 step2 ...
    const match = parts.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      emit(chalk.hex('#b15439')('  ✗ Usage: :workflow <name> "step 1" "step 2" ...'));
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
      emit(chalk.hex('#b15439')('  ✗ At least one step task is required.'));
      return { handled: true };
    }

    const steps: WorkflowStep[] = stepTasks.map((task: string, i: number) => ({
      name: `step-${i + 1}`,
      task,
    }));

    emit(chalk.hex('#cc785c').bold(`\n  Creating workflow "${workflowName}" with ${steps.length} steps...\n`));

    const state = await createWorkflow({ name: workflowName, steps });
    emit(chalk.hex('#5a9e6e')(`  ✓ Workflow created: ${state.definition.id}\n`));

    // Build the runStep callback using the REPL context's provider
    const runStep = async (task: string, stepIndex: number): Promise<StepResult> => {
      emit(chalk.hex('#cc785c')(`  ▸ Step ${stepIndex + 1}/${steps.length}: ${task}\n`));

      const { createResilientProvider } = await import('../providers/resilient-factory.js');
      const currentProvider = createResilientProvider(
        { model: c.providerConfig.model, apiKey: c.providerConfig.apiKey, baseUrl: c.providerConfig.baseUrl },
        {},
        c.display,
      );
      const result = await runAgentLoop({
        provider: currentProvider, task, context: c.ctx, permissions: c.permissions,
        display: c.display, initialHistory: [], maxTurns: c.defaultMaxTurns,
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
      emit(chalk.hex('#5a9e6e').bold(`\n  ✓ ${finalState.outcome}\n`));
    } else {
      emit(chalk.hex('#b15439').bold(`\n  ✗ ${finalState.outcome}`));
      emit(chalk.hex(TEXT_DIM_HEX)(`  Resume with: :resume-workflow ${finalState.definition.id}\n`));
    }

    return { handled: true };
  }

  if (input.startsWith(':resume-workflow ')) {
    const workflowId = input.slice(':resume-workflow '.length).trim();
    if (!workflowId) {
      emit(chalk.hex('#b15439')('  ✗ Usage: :resume-workflow <id>'));
      return { handled: true };
    }

    emit(chalk.hex('#cc785c').bold(`\n  Resuming workflow ${workflowId}...\n`));

    const runStep = async (task: string, stepIndex: number): Promise<StepResult> => {
      emit(chalk.hex('#cc785c')(`  ▸ Step ${stepIndex + 1}: ${task}\n`));

      const { createResilientProvider } = await import('../providers/resilient-factory.js');
      const currentProvider = createResilientProvider(
        { model: c.providerConfig.model, apiKey: c.providerConfig.apiKey, baseUrl: c.providerConfig.baseUrl },
        {},
        c.display,
      );
      const result = await runAgentLoop({
        provider: currentProvider, task, context: c.ctx, permissions: c.permissions,
        display: c.display, initialHistory: [], maxTurns: c.defaultMaxTurns,
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
      emit(chalk.hex('#b15439')(`  ✗ Workflow not found: ${workflowId}\n`));
      return { handled: true };
    }

    if (finalState.status === 'done') {
      emit(chalk.hex('#5a9e6e').bold(`\n  ✓ ${finalState.outcome}\n`));
    } else {
      emit(chalk.hex('#b15439').bold(`\n  ✗ ${finalState.outcome}`));
      emit(chalk.hex(TEXT_DIM_HEX)(`  Resume with: :resume-workflow ${finalState.definition.id}\n`));
    }

    return { handled: true };
  }

  return unhandled;
}

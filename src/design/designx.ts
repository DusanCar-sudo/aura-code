/**
 * `:designx` — Aura's design commission command.
 *
 * Flow: route 2-3 directions out of the style lexicon for this brief, build a
 * grounded research plan around them, hand both to the agent loop, and let the
 * agent write the artefact itself with its normal tools.
 *
 * Why the agent writes the files rather than this module capturing a summary
 * (the way :research does): a design artefact is the file. Round-tripping a
 * 900-line HTML document through a summary string is both lossy and pointless —
 * write_file already exists, runs under the permission system, and gets
 * checkpointed. This module's job is the routing and the report, nothing else.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runAgentLoop } from '../agent/loop.js';
import { routeStyles, type DesignStyle } from './styles.js';
import { buildScrapePlan } from './references.js';
import { buildDesignXPrompt } from './prompts.js';
import { slugifyBrief, type DesignXArgs } from './parse.js';
import { probeSearchAvailability } from '../tools/web-search.js';
import type { LLMProvider } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';

export interface DesignXResult {
  /** Absolute path to the output directory. */
  dir: string;
  /** Files the run actually produced, relative to `dir`. */
  files: string[];
  styles: DesignStyle[];
  summary: string;
  /** Set when the research pass was skipped because search was unusable. */
  searchNote?: string;
  /** Artefacts that were written but are not actually finished. */
  problems: ArtefactProblem[];
  turns: number;
  toolCalls: number;
  success: boolean;
}

/** Recursively list what ended up in the output directory. Reported rather
 *  than trusted from the model's own account of what it wrote — those two
 *  disagree often enough to be worth checking. */
function listOutputs(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listOutputs(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

/** Placeholder markers an unfinished artefact leaves behind. Seen in the wild:
 *  the agent wrote a valid-looking HTML skeleton whose style block held an
 *  INSERT_CSS_HERE comment and whose body held an INSERT_BODY_HERE one, planned
 *  to fill them in with follow-up shell calls, and those calls failed — leaving
 *  a 649-byte file that parses fine and is completely empty. `success` must not
 *  be true for that. */
const PLACEHOLDER_PATTERNS = [
  /INSERT_[A-Z_]*_HERE/,
  /<!--\s*(BODY|CONTENT|CSS|STYLES?|MAIN)\s*(GOES\s*HERE)?\s*-->/i,
  /\/\*\s*(BODY|CONTENT|CSS|STYLES?)\s*(GOES\s*HERE)?\s*\*\//i,
  /\bTODO\b|\bTBD\b|\bFIXME\b|\bLOREM IPSUM\b/i,
  /\bPLACEHOLDER\b/i,
];

/** Below this, an HTML artefact is a stub whatever it contains — a real page in
 *  any of these directions does not fit in 2 KB. */
const MIN_ARTEFACT_BYTES = 2_048;

export interface ArtefactProblem {
  file: string;
  problem: string;
}

/** Check the artefacts the run claims to have produced. Returns one entry per
 *  file that is not actually finished. DESIGN.md is exempt from the size floor
 *  (it is prose, and a short rationale is legitimate) but not from placeholders. */
export function inspectArtefacts(dir: string, files: string[]): ArtefactProblem[] {
  const problems: ArtefactProblem[] = [];
  for (const rel of files) {
    const full = path.join(dir, rel);
    let body: string;
    try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }

    const isMarkup = /\.(html?|svg|css)$/i.test(rel);
    for (const pattern of PLACEHOLDER_PATTERNS) {
      const hit = body.match(pattern);
      if (hit) {
        problems.push({ file: rel, problem: `unfilled placeholder: ${JSON.stringify(hit[0].slice(0, 40))}` });
        break;
      }
    }
    if (isMarkup && Buffer.byteLength(body) < MIN_ARTEFACT_BYTES) {
      problems.push({ file: rel, problem: `only ${Buffer.byteLength(body)} bytes — a stub, not a finished page` });
    }
  }
  return problems;
}

export interface RunDesignXOptions {
  projectRoot: string;
  args: DesignXArgs;
  provider: LLMProvider;
  context: ProjectContext;
  permissions: PermissionSystem;
  display: Display;
  /** Overrides the loop's turn budget. Design runs need real room: research,
   *  build, read back, revise. 30 was not enough in practice — runs that chose
   *  to assemble the document in pieces (against instructions, but they do)
   *  died mid-assembly at the cap, leaving a half-written stub. */
  maxTurns?: number;
}

export async function runDesignX(opts: RunDesignXOptions): Promise<DesignXResult> {
  const { projectRoot, args, provider, context, permissions, display } = opts;

  const styles = routeStyles({
    brief: args.brief,
    target: args.target,
    daring: args.daring,
    pinned: args.pinned,
    seed: args.seed,
    count: args.count,
  });

  const relOut = args.out ?? path.join('design', `${slugifyBrief(args.brief)}-${args.target}`);
  const absOut = path.resolve(projectRoot, relOut);
  fs.mkdirSync(absOut, { recursive: true });

  // Pre-flight the research pass. Without this, a blocked search backend turns
  // into the agent trying progressively simpler queries for a dozen turns and
  // then producing nothing — the prompt tells it to research, and it has no way
  // to know the tool is broken rather than the topic obscure. Probing once
  // costs one request and converts that into a clean, stated degrade.
  let plan = args.scrape ? buildScrapePlan(styles, args.target, args.brief) : null;
  let searchNote: string | undefined;
  if (plan) {
    const probe = await probeSearchAvailability();
    if (!probe.available) {
      plan = null;
      searchNote = `web_search unavailable (${probe.reason ?? 'unknown'}) — building from the routed directions alone.`;
      display.warning(searchNote);
    }
  }

  const task = buildDesignXPrompt({
    brief: args.brief,
    target: args.target,
    daring: args.daring,
    styles,
    plan,
    outDir: relOut,
  });

  const result = await runAgentLoop({
    provider,
    task,
    context,
    permissions,
    display,
    maxTurns: opts.maxTurns ?? 60,
    disableSpawn: true,
  });

  const files = listOutputs(absOut);
  const problems = inspectArtefacts(absOut, files);

  return {
    dir: absOut,
    files,
    styles,
    summary: result.summary ?? '',
    searchNote,
    problems,
    turns: result.turns ?? 0,
    toolCalls: result.toolCallCount ?? 0,
    // Judged on the artefact, not on how the loop exited. A run that produced a
    // clean, complete document but ran out of turns while admiring it is a
    // success; a run that exited cleanly having written only placeholders is
    // not. The artefact is the deliverable.
    success: files.length > 0 && problems.length === 0,
  };
}

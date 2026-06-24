import * as fs from 'fs';
import * as path from 'path';
import { runAgentLoop } from '../agent/loop.js';
import type { LLMProvider } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';

/**
 * Aura's `:research` — a focused, multi-step research pass on a topic.
 *
 * Pattern is inspired by ByteDance's DeerFlow SuperAgent harness: break a
 * topic into sub-questions, gather evidence (web_search/web_fetch, already
 * wired into the agent loop), and synthesise into a cited report. This is
 * intentionally the *minimal* version of that idea — it reuses the existing
 * agent loop and tool wiring rather than introducing a separate middleware
 * pipeline or concurrent sub-agent executor. If that proves too slow or
 * shallow for a given topic, the heavier DeerFlow-style architecture
 * (concurrent sub-agents, confidence-scored memory, sandboxing) is a
 * candidate for a later, separate pass — not bundled in here.
 *
 * Output is one dated Markdown file per topic under `<projectRoot>/research/`,
 * ending with a short attribution footer.
 */

const RESEARCH_DIRNAME = 'research';
const FOOTER = '\n---\n\n*Inspired by DeerFlow.*\n';

function researchDir(projectRoot: string): string {
  return path.join(projectRoot, RESEARCH_DIRNAME);
}

function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'topic';
}

function buildResearchTask(topic: string): string {
  return (
    `Research the following topic thoroughly and produce a well-organised, cited report: "${topic}"\n\n` +
    `Approach:\n` +
    `1. Break the topic into the 3-6 sub-questions that matter most (definition/background, ` +
    `current state, key players or evidence, open debates or unknowns, practical takeaway).\n` +
    `2. Search and fetch sources for each sub-question. Prefer primary/official sources over ` +
    `aggregators. Note where claims are speculative, unverified, or disputed — do not present ` +
    `speculation as settled fact.\n` +
    `3. Synthesise into Markdown with clear section headers per sub-question, plus a short ` +
    `"Bottom line" section at the end summarising the most defensible conclusion.\n` +
    `4. List sources used at the end under a "Sources" heading.\n\n` +
    `Respond with ONLY the finished Markdown report — no preamble, no meta-commentary about ` +
    `your process, no questions back to the user.`
  );
}

export interface ResearchResult {
  path: string;
  topic: string;
  turns: number;
  toolCalls: number;
}

/**
 * Run a research pass and save it to a dated file. Throws if the underlying
 * agent loop fails outright (caller should catch and report — there is no
 * silent error-stub here, unlike :dream, since a failed research run has no
 * partial state worth preserving).
 */
export async function runResearch(opts: {
  projectRoot: string;
  topic: string;
  provider: LLMProvider;
  context: ProjectContext;
  permissions: PermissionSystem;
  display: Display;
}): Promise<ResearchResult> {
  const { projectRoot, topic, provider, context, permissions, display } = opts;

  const result = await runAgentLoop({
    provider,
    task: buildResearchTask(topic),
    context,
    permissions,
    display,
    maxTurns: 12,
    disableSpawn: true,
  });

  const body = (result.summary ?? '').trim() || '_No content was returned for this research pass._';
  const md = `# ${topic}\n\n${body}\n${FOOTER}`;

  const dir = researchDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join(dir, `${date}-${slugify(topic)}.md`);
  fs.writeFileSync(outPath, md);

  return {
    path: outPath,
    topic,
    turns: result.turns ?? 0,
    toolCalls: result.toolCallCount ?? 0,
  };
}

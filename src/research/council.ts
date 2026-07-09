import * as fs from 'fs';
import * as path from 'path';
import { marked } from 'marked';
import { runAgentLoop } from '../agent/loop.js';
import { createProvider } from '../providers/factory.js';
import type { LLMProvider } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';

/**
 * Aura's `:council` ("Ecclesia") — N independent research agents investigate
 * the same topic, then a synthesis pass reconciles their findings into one
 * verdict: what they agreed on, what's contested, and what only a minority
 * caught. Default panel size is 5 — odd, so majority agreement is always
 * decisive (no 2.5/2.5 ties).
 *
 * Cost design, deliberately conservative (see compaction/dream incidents):
 *   - The N panel agents run SEQUENTIALLY, each a short findings-only pass
 *     (not a full polished report). Local models produce catastrophic factual
 *     errors (e.g. hallucinated Djokovic stats), so Ollama is not a
 *     supported default.
 *   - Only the final synthesis step is reasoning-heavy; it runs as a single
 *     call on the caller's active provider.
 *   - Per-agent turns are capped well below :research's full budget.
 *
 * Panel model resolution (in priority order):
 *   1. `opts.panelModel` — explicit caller override (CLI: `--panel <model>`).
 *   2. `AURA_PANEL_MODEL` env var — global default for cheap-panel setups.
 *   3. The synthesis provider's own model — the user's already-configured
 *      and authenticated model, whatever it is. This works for every user
 *      without assuming Xiaomi / OpenAI / any specific provider.
 *
 * Cost note: option 3 means a 5-agent council costs ~5× a single :research
 * pass on whatever the user is paying for. Users who want cheaper runs can
 * set AURA_PANEL_MODEL globally, or pass `--panel <fast-model>` per call.
 *
 * Output: dated `.md` + `.html` under `<projectRoot>/council/`.
 */

const COUNCIL_DIRNAME = 'council';
const DEFAULT_PANEL_SIZE = 5;
const FOOTER = '\n---\n\n*Ecclesia — five voices, one verdict. Inspired by DeerFlow.*\n';

function councilDir(projectRoot: string): string {
  return path.join(projectRoot, COUNCIL_DIRNAME);
}

function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'topic';
}

function buildPanelTask(topic: string, seat: number, panelSize: number): string {
  return (
    `You are panel seat ${seat} of ${panelSize} in an independent research council on this topic: "${topic}"\n\n` +
    `Research it on your own — search and fetch what you need. Do NOT try to write a polished ` +
    `report. Instead, respond with ONLY a compact findings list:\n\n` +
    `- 4-8 bullet points, each one specific claim or finding, with its source noted in parentheses.\n` +
    `- If something is disputed, speculative, or you're unsure, say so explicitly in that bullet.\n` +
    `- End with one line: "Stance: <your one-sentence bottom-line take>"\n\n` +
    `No preamble, no headers, no questions back. Just the bullets and the stance line.`
  );
}

function buildSynthesisPrompt(topic: string, findings: string[]): { system: string; user: string } {
  const system =
    'You are Aura synthesising an Ecclesia — an independent research council. You are given ' +
    `${findings.length} separate agents' findings on the same topic, gathered without them seeing ` +
    'each other\'s work. Reconcile them into one verdict. Respond in Markdown with EXACTLY these ' +
    'sections:\n\n' +
    '## Convergent findings\n(claims most or all agents independently arrived at — high confidence)\n\n' +
    '## Contested\n(claims where agents disagreed, or where a majority/minority split exists — name the split, ' +
    'e.g. "3 of 5 agents..." )\n\n' +
    '## Minority signal\n(something only one or two agents caught that seems worth surfacing anyway, even if unconfirmed)\n\n' +
    '## Verdict\n(the council\'s bottom-line conclusion — what an informed reader should walk away believing, ' +
    'and how confident that conclusion is)\n\n' +
    '## Sources\n(consolidated list of sources cited across all agents)';
  const user =
    `Topic: ${topic}\n\n` +
    findings.map((f, i) => `### Agent ${i + 1}\n${f}`).join('\n\n');
  return { system, user };
}

function mdToHtml(md: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  return marked.parse(md) as string;
}

function wrapHtml(title: string, bodyHtml: string, date: string, panelSize: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — Ecclesia</title>
<style>
  :root {
    --bg: #fdf6f0; --card: #fffaf5; --text: #3e2f24; --muted: #8a7768;
    --accent: #cc785c; --accent-2: #5a9e6e; --border: #e8d5c8;
    --code-bg: #f4ede6; --bq: #cc785c; --hr: #e0cebc;
    --shadow: 0 2px 12px rgba(62,47,36,0.06); --radius: 12px;
    --serif: 'Georgia', 'Times New Roman', serif;
    --sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1b18; --card: #26221e; --text: #ede0cc; --muted: #9e8e80;
      --accent: #e08a6e; --accent-2: #6db880; --border: #3a322a;
      --code-bg: #2c2722; --bq: #e08a6e; --hr: #3a322a;
      --shadow: 0 2px 12px rgba(0,0,0,0.25);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--serif); line-height: 1.75; font-size: 18px; }
  .container { max-width: 780px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  .hero { text-align: center; padding: 3rem 0 2.5rem; border-bottom: 2px solid var(--border); margin-bottom: 2.5rem; }
  .hero .badge { display: inline-block; background: var(--accent); color: #fff; font-family: var(--sans); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.3em 1em; border-radius: 100px; margin-bottom: 1.25rem; }
  .hero h1 { font-family: var(--sans); font-size: 2.4rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
  .hero .meta { font-family: var(--sans); font-size: 0.85rem; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 2.5rem 3rem; }
  @media (max-width: 640px) { .card { padding: 1.5rem; border-radius: 8px; } .hero h1 { font-size: 1.7rem; } .container { padding: 1.5rem 0.75rem 3rem; } }
  .card h1, .card h2, .card h3 { font-family: var(--sans); margin: 2rem 0 0.75rem; line-height: 1.3; }
  .card h2:first-child { margin-top: 0; }
  .card h2 { font-size: 1.45rem; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 0.4rem; }
  .card h3 { font-size: 1.1rem; color: var(--accent-2); }
  .card p { margin: 0.85rem 0; }
  .card a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent); }
  .card ul, .card ol { margin: 0.85rem 0; padding-left: 1.8rem; }
  .card li { margin: 0.4rem 0; }
  .card code { font-family: var(--mono); font-size: 0.88em; background: var(--code-bg); padding: 0.15em 0.4em; border-radius: 4px; border: 1px solid var(--border); }
  .card hr { border: none; border-top: 1px solid var(--hr); margin: 2rem 0; }
  .footer { text-align: center; margin-top: 2.5rem; font-family: var(--sans); font-size: 0.8rem; color: var(--muted); opacity: 0.7; }
</style>
</head>
<body>
<div class="container">
  <header class="hero">
    <div class="badge">Ecclesia &middot; ${panelSize} agents</div>
    <h1>${esc(title)}</h1>
    <div class="meta">${date}</div>
  </header>
  <article class="card">
${bodyHtml}
  </article>
  <footer class="footer"><p>Generated by Aura Code &middot; Ecclesia &middot; Inspired by DeerFlow</p></footer>
</div>
</body>
</html>`;
}

export interface CouncilResult {
  path: string;
  htmlPath: string;
  topic: string;
  panelSize: number;
  panelModel: string;
  agentFailures: number;
}

/**
 * Pick which model the panel agents run on.
 *
 * Priority:
 *   1. `override` — explicit `opts.panelModel` (set by `--panel <model>`)
 *   2. `AURA_PANEL_MODEL` env var — global default for cheap-panel setups
 *   3. The synthesis provider's `.model` — the user's authenticated, working
 *      model. Means the council just works for whoever ran `:provider`,
 *      without assuming any specific vendor.
 *
 * If none of these yield a model, throw with a clear message rather than
 * passing `undefined` to `createProvider` (which historically produced
 * opaque "400 Not supported model" errors).
 */
function resolvePanelModel(
  synthesisProvider: LLMProvider,
  override?: string,
  configuredModel?: string,
): string {
  if (override && override.trim()) return override.trim();

  const env = process.env.AURA_PANEL_MODEL;
  if (env && env.trim()) return env.trim();

  // The caller's configured routing id (e.g. "deepseek/deepseek-v4-flash").
  // Preferred over the provider instance's `.model`, which has the provider
  // prefix stripped ("deepseek-v4-flash") and therefore re-resolves through
  // the generic OpenAI-compatible provider — the wrong endpoint entirely
  // (this produced five identical 401s on the first live Ecclesia run).
  if (configuredModel && configuredModel.trim()) return configuredModel.trim();

  const fromProvider = (synthesisProvider as unknown as { model?: string }).model;
  if (fromProvider && fromProvider.trim()) return fromProvider.trim();

  throw new Error(
    'Could not resolve a panel model. Pass --panel <model>, ' +
    'set AURA_PANEL_MODEL, or configure a provider via :provider first.',
  );
}

/**
 * Run an Ecclesia: `panelSize` independent agents research the topic
 * sequentially, then one synthesis call on the caller's active provider
 * reconciles their findings into a verdict.
 */
export async function runCouncil(opts: {
  projectRoot: string;
  topic: string;
  synthesisProvider: LLMProvider;
  context: ProjectContext;
  permissions: PermissionSystem;
  display: Display;
  panelSize?: number;
  panelModel?: string;
  /** The session's configured routing model id (e.g. "deepseek/deepseek-v4-flash"). */
  configuredModel?: string;
}): Promise<CouncilResult> {
  const {
    projectRoot, topic, synthesisProvider, context, permissions, display,
  } = opts;
  const panelSize = Math.max(1, opts.panelSize ?? DEFAULT_PANEL_SIZE);
  const panelModel = resolvePanelModel(synthesisProvider, opts.panelModel, opts.configuredModel);

  const findings: string[] = [];
  let agentFailures = 0;

  // Sequential by design — see module doc. Each agent is independent: no
  // agent sees another's findings, so agreement/disagreement is genuine.
  for (let seat = 1; seat <= panelSize; seat++) {
    try {
      const panelProvider = createProvider({ model: panelModel });
      const res = await runAgentLoop({
        provider: panelProvider,
        task: buildPanelTask(topic, seat, panelSize),
        context,
        permissions,
        display,
        maxTurns: 6,
        disableSpawn: true,
      });
      let text = (res.summary ?? '').trim();
      if (!res.success || /^Loop (ended|stalled)/i.test(text)) {
        // The agent hit its turn cap (or stalled) before a final answer, so
        // summary is just the loop-end marker. Salvage its last real message
        // instead — feeding "Loop ended after 6 turns." to the synthesis
        // makes the model fabricate an entire council from nothing (observed
        // live: invented "3 of 5 agents" splits and fictional sources).
        const lastAssistant = [...res.history].reverse().find(
          (m): m is { role: 'assistant'; content: string } =>
            m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0,
        );
        text = lastAssistant?.content.trim() ?? '';
      }
      if (!text) {
        // Tool-happy models (observed: DeepSeek) spend every turn on tool
        // calls and never write prose, so there is nothing to salvage.
        // Convert the research they DID gather into findings with one
        // tool-less completion over their own history.
        const wrap = await panelProvider.complete(
          'Your tool budget is exhausted. Using ONLY what you already gathered in this conversation, ' +
          'write the findings now in the requested format: 4-8 specific bullet points with sources in ' +
          'parentheses, then one line "Stance: <bottom-line take>". Do not call tools. No preamble.',
          [...res.history, { role: 'user', content: 'Tool budget exhausted — write your findings list and stance NOW.' }],
          [],
        );
        text = (wrap.text ?? '').trim();
      }
      findings.push(text || `(Agent ${seat} returned no findings.)`);
    } catch (err) {
      agentFailures++;
      findings.push(`(Agent ${seat} failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Synthesis — one call, on the caller's real provider.
  const { system, user } = buildSynthesisPrompt(topic, findings);
  let verdictBody: string;
  try {
    const synth = await synthesisProvider.complete(system, [{ role: 'user', content: user }], []);
    verdictBody = (synth.text ?? '').trim();
  } catch (err) {
    verdictBody =
      `## Convergent findings\n_Synthesis failed: ${err instanceof Error ? err.message : String(err)}_\n\n` +
      `## Contested\n- none (synthesis did not run)\n\n## Minority signal\n- none\n\n` +
      `## Verdict\nSynthesis could not run, but the ${panelSize} agents' raw findings are preserved below.\n\n## Sources\n- see raw findings`;
  }

  const rawFindingsSection =
    `\n\n---\n\n## Raw panel findings\n\n` +
    findings.map((f, i) => `### Agent ${i + 1}\n\n${f}`).join('\n\n');

  const md = `# Ecclesia: ${topic}\n\n${verdictBody}${rawFindingsSection}\n${FOOTER}`;

  const dir = councilDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(topic);

  const mdPath = path.join(dir, `${date}-${slug}.md`);
  fs.writeFileSync(mdPath, md);

  const htmlOut = wrapHtml(topic, mdToHtml(`${verdictBody}${rawFindingsSection}`), date, panelSize);
  const htmlPath = path.join(dir, `${date}-${slug}.html`);
  fs.writeFileSync(htmlPath, htmlOut);

  return { path: mdPath, htmlPath, topic, panelSize, panelModel, agentFailures };
}

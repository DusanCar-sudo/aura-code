/**
 * Task-derived prompt guidance, delivered through history instead of the
 * system prompt.
 *
 * Two blocks used to be compiled into the system prompt from the *current
 * task text*: the domain-expertise checklists (domain-expertise.ts, keyword
 * classification) and the conditional plugin-skill bodies (gated on
 * WEB_KEYWORDS). Both still exist, but they no longer live in the system
 * prompt, because a task-dependent system prompt defeats every provider's
 * prompt cache in a multi-segment conversation: runCoderConversation carries
 * history across segments while runAgentLoop rebuilds the system prompt for
 * each message, so the moment one message classifies differently from the
 * last ("fix the parser" → "thanks"), the prefix changes byte-for-byte and
 * the entire history — the quadratic part of the bill — re-sends at full
 * input price.
 *
 * The fix rides on an invariant both compaction strategies already rely on:
 * a message, once pushed into history, is never rewritten. Guidance is
 * appended to the kickoff user message at push time and stays there, so the
 * system prompt is byte-identical for the whole session and the guidance is
 * still delivered per task. On `--resume` the wrapped message replays from
 * the session file and the rebuilt system prompt is unchanged, so the
 * prefix cache-hits where the old design always missed.
 *
 * Anything that reads user-message text (session titles, the conditional-tool
 * gate, summarizers) must call stripTaskGuidance first — guidance contains
 * domain keywords that would otherwise leak into titles or spuriously
 * trigger conditional tools like `github`.
 */
import { getDomainPromptBlock } from './domain-expertise.js';
import { loadAllPlugins } from '../plugins/loader.js';

/**
 * Separates the task text from appended guidance. Line-framed with a heading
 * so the model reads it as annotation, not as part of the request.
 */
export const TASK_GUIDANCE_DELIMITER = '\n\n---\n## Task guidance\n';

const WEB_KEYWORDS = /website|webpage|frontend|front-end|ui component|landing page|homepage|web app|portfolio|hero section|marketing page|site design|visual design|html.*css|make.*page|create.*page|build.*site/;

/**
 * Guidance for one task: domain-expertise checklists plus any plugin skill
 * bodies whose gate matches. Empty string when nothing applies — most tasks
 * need nothing beyond the base system prompt.
 *
 * Classified from the *raw* user task (pre-inspector), so the report the
 * inspector appends cannot swing the classification.
 */
export function buildTaskGuidance(task: string): string {
  const domainBlock = getDomainPromptBlock(task);
  const pluginBlock = loadPluginSkillsBlock(task);
  return domainBlock + pluginBlock;
}

/**
 * Load plugin skills relevant to the current task. Cached per process for
 * the same reason the memory/confession blocks in system-prompt.ts are: the
 * result is appended into history, and a skill installed mid-session must
 * not change bytes that earlier turns already sent.
 */
let _pluginSkillsCache: string | null = null;

function loadPluginSkillsBlock(task: string): string {
  if (_pluginSkillsCache === null) {
    try {
      const plugins = loadAllPlugins();
      const always: string[] = [];
      const conditional: string[] = [];
      for (const p of plugins) {
        for (const s of p.skills) {
          const line = `\n\n## Plugin skill: ${s.name} (from ${p.name})\n${s.body}`;
          if (s.alwaysOn) always.push(line);
          else conditional.push(line);
        }
      }
      _pluginSkillsCache = JSON.stringify({ always, conditional });
    } catch {
      _pluginSkillsCache = '""';
    }
  }
  if (!_pluginSkillsCache || _pluginSkillsCache === '""') return '';
  const { always, conditional } = JSON.parse(_pluginSkillsCache) as { always: string[]; conditional: string[] };
  // Always-on skills (e.g. ponytail) apply to every task — the agent needs the
  // rules before it writes anything. Other plugin skills stay web/UI-only to
  // avoid polluting non-design prompts.
  const parts: string[] = [];
  if (always.length > 0) {
    parts.push(`\n\n## Plugin instructions\nThese always-on skill instructions apply to every task:${always.join('')}`);
  }
  if (conditional.length > 0 && WEB_KEYWORDS.test(task.toLowerCase())) {
    parts.push(`\n\n## Plugin instructions\nThese skill instructions from installed plugins apply to this task:${conditional.join('')}`);
  }
  return parts.join('');
}

/**
 * The user-visible half of a guidance-wrapped message: everything before the
 * delimiter. Text without the delimiter (tasks with no guidance, mid-run
 * steering messages, histories from before this existed) passes through
 * unchanged.
 */
export function stripTaskGuidance(text: string): string {
  const idx = text.indexOf(TASK_GUIDANCE_DELIMITER);
  return idx === -1 ? text : text.slice(0, idx);
}

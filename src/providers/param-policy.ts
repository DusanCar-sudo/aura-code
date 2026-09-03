// ─────────────────────────────────────────────────────────────────────────────
// Sampling parameters an endpoint refuses to be flexible about.
//
// Most OpenAI-compatible endpoints treat temperature and the penalties as a
// range. A few pin them to one value and answer anything else with a hard 400,
// naming the parameter and the only value they accept:
//
//   invalid temperature: only 1 is allowed for this model
//   invalid presence_penalty: only 0 is allowed for this model
//   invalid top_p: only 0.95 is allowed for this model
//
// Aura's defaults (temperature 0.2, penalties 0.3 — chosen for code generation
// and to break DeepSeek's repetition loops) violate all three, so on such an
// endpoint *every* request fails before a single token is generated. That is
// what "Provider error: HTTP 400: 400 invalid temperature" on a plain `hello`
// was: not a bad key, not a bad model id, just three defaults the endpoint
// does not allow.
//
// The walls stand behind each other — correcting temperature alone surfaces
// the penalty error next — so a policy has to describe every pinned parameter
// at once, which is why this is a table rather than a patch at one call site.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The values a target insists on. An omitted field means "no constraint —
 * use Aura's default".
 */
export interface ParamPolicy {
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

/**
 * Moonshot (Kimi) pins all three.
 *
 * Verified live against api.moonshot.ai on 2026-09-03 across every model the
 * endpoint currently lists — kimi-k3, kimi-k2.6, kimi-k2.7-code and
 * kimi-k2.7-code-highspeed all reject temperature 0.2 identically, so this is
 * a property of the endpoint rather than of one model. `reasoning_effort` and
 * tool definitions are accepted unchanged.
 */
const MOONSHOT: ParamPolicy = { temperature: 1, frequencyPenalty: 0, presencePenalty: 0 };

/**
 * The policy for a target, or undefined when it has no pinned parameters.
 *
 * Keyed off the model id and endpoint rather than the display name, for the
 * same reason `supportsFullLadder` is: the factory reaches this provider for a
 * `kimi/`-prefixed id, for a bare Moonshot model name, and for a custom
 * `.aura.json` provider pointing at the same endpoint under any label.
 */
export function paramPolicyFor(target: { model?: string; baseUrl?: string }): ParamPolicy | undefined {
  const m = (target.model ?? '').toLowerCase();
  const url = (target.baseUrl ?? '').toLowerCase();
  if (m.startsWith('kimi/') || m.startsWith('kimi-') || m.startsWith('moonshot-')
      || url.includes('moonshot.ai') || url.includes('moonshot.cn')) {
    return MOONSHOT;
  }
  return undefined;
}

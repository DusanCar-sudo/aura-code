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

// ─────────────────────────────────────────────────────────────────────────────
// 401s that name their own cause.
//
// Providers mostly issue `sk-…` keys, so a key pasted into the wrong
// provider's slot authenticates nowhere and the endpoint's answer — a bare
// "Invalid Authentication" — gives nothing away. The prefixes below are
// distinctive enough to recognise, so a 401 can say what was probably
// pasted where. Seen in the wild: an OpenRouter key under MOONSHOT_API_KEY,
// which 401s every Kimi request until the real key is restored.
// ─────────────────────────────────────────────────────────────────────────────

/** Key prefixes that identify a provider other than the one being called. */
const KEY_PREFIXES: Array<{ prefix: string; label: string }> = [
  { prefix: 'sk-or-v1-', label: 'an OpenRouter key' },
  { prefix: 'sk-or-',      label: 'an OpenRouter key' },
  { prefix: 'sk-ant-',     label: 'an Anthropic key' },
  { prefix: 'gsk_',        label: 'a Groq key' },
  { prefix: 'r8_',         label: 'a Replicate key' },
  { prefix: 'AIza',        label: 'a Google API key' },
];

/**
 * A hint for a 401 from this target, or undefined when the key looks plausible
 * (or is hidden from us). Only ever names the *kind* of key — never any part
 * of the key itself.
 */
export function authErrorHint(
  target: { model?: string; baseUrl?: string },
  apiKey?: string,
): string | undefined {
  if (!apiKey) return undefined;
  const wrong = KEY_PREFIXES.find((k) => apiKey.startsWith(k.prefix));
  if (!wrong) return undefined;
  // An OpenRouter key is correct on OpenRouter — only flag it elsewhere.
  const isOpenRouter = target.model?.startsWith('openrouter/')
    || (target.baseUrl ?? '').includes('openrouter.ai');
  if (wrong.label.includes('OpenRouter') && isOpenRouter) return undefined;
  return `the stored key for this provider is ${wrong.label} — it was probably saved into the wrong provider's slot (:apikey the correct key, or Settings → Models)`;
}

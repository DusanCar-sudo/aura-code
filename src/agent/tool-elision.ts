/**
 * Tool-call argument elision — history-only compression of assistant tool
 * calls.
 *
 * Assistant tool-call arguments live in conversation history and are re-sent
 * to the provider on every subsequent turn (compactor.countMessage bills the
 * full JSON of `call.input`). A single `write_file` with a 20 KB `content`
 * payload is therefore paid for on every later call — including after
 * compaction, which only shrinks what it can see. The bytes are on disk; the
 * model only needs to know WHAT it did, not the full payload it sent.
 *
 * `elideToolCallArgs` replaces large string arguments with a size stub when
 * the assistant message is pushed into history. The live call keeps its full
 * arguments everywhere else (display, toolCallLog, execQueue, read cache,
 * verification) — only the history copy is compressed. Because elision is
 * applied consistently at push time, the history bytes stay stable across
 * calls after the first, so a provider prompt-cache breakpoint placed after
 * the message is not thrashed by it.
 */
import type { ToolCall } from '../providers/types.js';

/** String arguments longer than this (chars) are replaced by a size stub. */
export const ELIDE_STRING_AFTER_CHARS = 2_000;
/** `edit_file.find` keeps a prefix — it names the block the edit matched on,
 *  so the model can still tell what was replaced. */
const FIND_KEEP_CHARS = 500;
/**
 * Tools whose arguments are never elided: the spawn prompt IS the payload —
 * the sub-agent's report comes back as the tool result, and later turns
 * legitimately need to recall what was asked.
 */
const NEVER_ELIDE_TOOLS = new Set(['spawn_task']);

function elideValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= ELIDE_STRING_AFTER_CHARS) return value;
    if (key === 'find') {
      return `${value.slice(0, FIND_KEEP_CHARS)}…[+${(value.length - FIND_KEEP_CHARS).toLocaleString()} chars omitted]`;
    }
    return `[${key}: ${value.length.toLocaleString()} chars omitted — payload too large to keep in context]`;
  }
  if (Array.isArray(value)) return value.map((v) => elideValue(key, v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = elideValue(k, v);
    }
    return out;
  }
  return value;
}

/** History-safe copy of a tool call: large string args replaced by stubs. */
export function elideToolCallArgs(call: ToolCall): ToolCall {
  if (NEVER_ELIDE_TOOLS.has(call.name)) return call;
  return { ...call, input: elideValue('input', call.input) as Record<string, unknown> };
}

/**
 * Gemini messages carry the raw response parts (`googleParts`); the Google
 * provider re-serializes those verbatim on every turn (providers/google.ts),
 * which would bypass elideToolCallArgs entirely. Apply the same elision to
 * every functionCall part's args so the payload stays compressed for Gemini
 * sessions too.
 */
export function elideGoogleParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) return parts;
  return parts.map((part) => {
    if (part !== null && typeof part === 'object' && 'functionCall' in (part as Record<string, unknown>)) {
      const fc = (part as { functionCall?: { args?: unknown } }).functionCall;
      if (!fc) return part;
      return {
        ...part,
        functionCall: { ...fc, args: elideValue('input', fc.args) },
      };
    }
    return part;
  });
}

/**
 * Reasoning-model output handling for OpenAI-compatible endpoints.
 *
 * Reasoning models express chain-of-thought in one of two shapes, and a client
 * that reads only `delta.content` mishandles both:
 *
 *  1. **Separate field.** Ollama's /v1 layer maps its native `thinking` onto
 *     `delta.reasoning` (non-streaming: `message.reasoning`), leaving
 *     `delta.content` empty until the thinking phase ends. Measured on
 *     gemma-archimedes-gen2 with max_tokens=300: 271 chunks carrying
 *     `reasoning`, **zero** carrying `content`. Reading only `content` yields
 *     an empty answer. With a larger budget the same prompt puts the real
 *     answer in `content` ("36") — so the failure is budget-dependent, which
 *     is why it looked intermittent.
 *
 *  2. **In-band tags.** Other stacks emit `<think>…</think>` inside `content`
 *     itself. Reading `content` verbatim leaks the trace into the answer.
 *
 * Both must resolve to the same thing: callers see the final answer only, and
 * a response whose thinking crowded out the content never renders as empty.
 */

/** Reasoning is exposed under different names depending on the vendor. */
export function readReasoningField(o: unknown): string {
  if (!o || typeof o !== 'object') return '';
  const r = o as { reasoning?: unknown; reasoning_content?: unknown };
  const v = typeof r.reasoning === 'string' ? r.reasoning
    : typeof r.reasoning_content === 'string' ? r.reasoning_content
    : '';
  return v;
}

const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;
/** Longest tag we might be midway through when a chunk boundary lands. */
const MAX_TAG_LEN = '</thinking>'.length;

/**
 * How many trailing chars must be withheld because they could be the start of
 * a tag split across chunks. Without this, a chunk ending in `"…answer <"` and
 * the next starting `"think>"` would emit a stray `<` and then fail to strip.
 */
function heldSuffixLength(s: string): number {
  const li = s.lastIndexOf('<');
  if (li === -1) return 0;
  const tail = s.slice(li);
  if (tail.length >= MAX_TAG_LEN) return 0; // long enough to have matched already
  const lower = tail.toLowerCase();
  return '<think>'.startsWith(lower) || '<thinking>'.startsWith(lower)
    || '</think>'.startsWith(lower) || '</thinking>'.startsWith(lower)
    ? tail.length
    : 0;
}

/**
 * Incremental `<think>…</think>` stripper for streamed content.
 *
 * Stateful across chunks: tags, and the reasoning between them, routinely
 * straddle chunk boundaries. `push` returns only the text safe to show now;
 * `flush` releases whatever was held back at end of stream.
 */
export class ThinkTagStripper {
  private inside = false;
  private pending = '';
  private reasoning = '';

  /** Chain-of-thought seen so far, tags removed. */
  get reasoningText(): string { return this.reasoning; }

  push(chunk: string): string {
    this.pending += chunk;
    let out = '';

    for (;;) {
      if (!this.inside) {
        const m = OPEN_RE.exec(this.pending);
        if (m) {
          out += this.pending.slice(0, m.index);
          this.pending = this.pending.slice(m.index + m[0].length);
          this.inside = true;
          continue;
        }
        const hold = heldSuffixLength(this.pending);
        out += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        return out;
      }

      const m = CLOSE_RE.exec(this.pending);
      if (m) {
        this.reasoning += this.pending.slice(0, m.index);
        this.pending = this.pending.slice(m.index + m[0].length);
        this.inside = false;
        continue;
      }
      const hold = heldSuffixLength(this.pending);
      this.reasoning += this.pending.slice(0, this.pending.length - hold);
      this.pending = this.pending.slice(this.pending.length - hold);
      return out;
    }
  }

  /** End of stream — an unterminated `<think>` means everything after it was
   *  reasoning, not answer, so it must not be emitted as visible text. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    if (this.inside) { this.reasoning += rest; return ''; }
    return rest;
  }
}

/**
 * Final answer for a reasoning-model response.
 *
 * Falls back to the reasoning trace only when there is no content at all:
 * a truncated thinking phase would otherwise render as an empty answer, which
 * is strictly worse than a verbose one — empty carries no information and, in
 * the agent loop, burns a turn on an empty-response retry. Content always wins
 * when present, so this never leaks the trace into an answer that exists.
 */
export function resolveAnswer(content: string, reasoning: string): string {
  if (content.trim()) return content;
  if (!reasoning.trim()) return content;
  
  // A truncated thinking phase (empty content) means the model exhausted its token
  // budget during reasoning. Returning the raw reasoning trace here poisons the 
  // conversation context for future turns and causes runaway generation loops.
  // Instead, we return a clear indicator so the model knows to try again.
  return "[System Error: Model exhausted token budget during reasoning phase. No final answer was provided.]";
}

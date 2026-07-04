import { jsonrepair } from 'jsonrepair';

/**
 * Parse tool-call argument JSON from a provider stream, tolerating the kind
 * of malformed output reasoning models (GLM-5.2, etc.) produce when they
 * inline large multi-line strings (HTML/code) directly as JSON arguments —
 * unescaped quotes, literal newlines, stray backticks.
 *
 * Falls back to jsonrepair before giving up to { _raw }, so most truncated/
 * malformed tool calls execute correctly instead of erroring out and forcing
 * the model to retry via shell heredocs.
 */
export function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const repaired = jsonrepair(raw);
      return JSON.parse(repaired);
    } catch {
      return { _raw: raw };
    }
  }
}

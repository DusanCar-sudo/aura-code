import { marked } from 'marked';

/**
 * Markdown rendering and sanitisation.
 *
 * Extracted from the component so it can be tested. A chat client renders
 * model output — which is untrusted text, and on the agent path can carry
 * whatever a tool read off disk or off the network. Rendering that as live
 * HTML is an XSS hole with a nice font, so this is the one piece of the
 * client that genuinely must not regress.
 *
 * Two layers, deliberately:
 *   1. the renderer refuses to emit raw HTML at all, and
 *   2. the result is scrubbed anyway.
 *
 * Layer 2 exists because layer 1 depends on marked's behaviour for every input
 * shape, and a defence that rests on one library's edge cases is not a defence.
 */

marked.setOptions({ gfm: true, breaks: true });

/**
 * Strip the vectors that survive "no raw HTML": tag pairs, self-closing tags,
 * inline event handlers, and javascript: URLs.
 */
export function scrub(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1="#"');
}

/** Render markdown to sanitised HTML. */
export function renderMarkdown(text: string): string {
  const renderer = new marked.Renderer();
  // Never emit author-supplied HTML.
  renderer.html = () => '';
  const out = marked.parse(text, { renderer, async: false }) as string;
  return scrub(out);
}

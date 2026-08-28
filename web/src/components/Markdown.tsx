import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';

/**
 * Markdown rendering with copyable code blocks.
 *
 * `marked` is already a dependency of the engine, so this costs no new package.
 *
 * Sanitisation: model output is untrusted text. marked does not sanitise, so
 * raw HTML is disabled at the renderer level and the result is additionally
 * scrubbed of script/style/event-handler vectors before it reaches innerHTML.
 * A chat client that renders model output as live HTML is an XSS hole with a
 * nice font.
 */

marked.setOptions({ gfm: true, breaks: true });

/** Strip the vectors that survive "no raw HTML" — belt and braces. */
function scrub(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1="#"');
}

function renderMarkdown(text: string): string {
  const renderer = new marked.Renderer();
  // Never emit author-supplied HTML.
  renderer.html = () => '';
  const out = marked.parse(text, { renderer, async: false }) as string;
  return scrub(out);
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);

  // Code blocks get a copy affordance. Done post-render rather than in the
  // renderer so the button is a real element with real focus behaviour.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      if (pre.querySelector('.code-copy')) continue;
      pre.classList.add('code-block');
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        void navigator.clipboard?.writeText(code).then(
          () => {
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
          },
          () => { btn.textContent = 'Failed'; },
        );
      });
      pre.appendChild(btn);
    }
  }, [html]);

  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Copy-to-clipboard button for a whole message. */
export function CopyButton({ text, label, copiedLabel }: {
  text: string; label: string; copiedLabel: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="msg-action"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? copiedLabel : label}
    </button>
  );
}

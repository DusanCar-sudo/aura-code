import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../lib/markdown';

/**
 * Markdown rendering with copyable code blocks.
 *
 * The rendering and sanitisation live in lib/markdown.ts so they can be
 * tested; this file is the DOM half.
 */

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

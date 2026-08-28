import { describe, it, expect } from 'vitest';
import { scrub, renderMarkdown } from '../../web/src/lib/markdown';

// ─────────────────────────────────────────────────────────────────────────────
// The web client renders model output as HTML.
//
// That output is untrusted: on the agent path it carries whatever a tool read
// off disk or off the network, so a prompt-injected file can put markup in
// front of the operator. This is the one piece of the client that genuinely
// must not regress, which is why it is tested against the vectors rather than
// eyeballed.
// ─────────────────────────────────────────────────────────────────────────────

describe('scrub — the vectors that survive "no raw HTML"', () => {
  it('removes a script element and its contents', () => {
    expect(scrub('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('removes a self-closing or unclosed script tag', () => {
    expect(scrub('<script src="//evil.example/x.js">')).toBe('');
  });

  it('removes style, iframe, object, embed, link and meta', () => {
    for (const tag of ['style', 'iframe', 'object', 'embed', 'link', 'meta']) {
      expect(scrub(`<${tag}>x</${tag}>`)).toBe('');
      expect(scrub(`<${tag} foo="bar">`)).toBe('');
    }
  });

  it('survives whitespace and case games inside the tag', () => {
    expect(scrub('< SCRIPT >alert(1)< / script >')).toBe('');
    expect(scrub('<ScRiPt>alert(1)</ScRiPt>')).toBe('');
  });

  it('strips inline event handlers in every quoting style', () => {
    expect(scrub('<img onerror="alert(1)">')).toBe('<img>');
    expect(scrub("<img onerror='alert(1)'>")).toBe('<img>');
    expect(scrub('<img onerror=alert(1)>')).toBe('<img>');
    expect(scrub('<div ONCLICK="x">t</div>')).toBe('<div>t</div>');
  });

  it('defuses javascript: URLs on href and src', () => {
    expect(scrub('<a href="javascript:alert(1)">x</a>')).toBe('<a href="#">x</a>');
    expect(scrub("<a href='javascript:alert(1)'>x</a>")).toBe('<a href="#">x</a>');
    expect(scrub('<img src="javascript:alert(1)">')).toBe('<img src="#">');
  });

  it('leaves ordinary markup alone', () => {
    const safe = '<p>hello <strong>there</strong></p><a href="https://example.com">link</a>';
    expect(scrub(safe)).toBe(safe);
  });
});

describe('renderMarkdown — the whole path', () => {
  it('renders ordinary markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.');
    expect(html).toContain('Title');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('does not emit raw HTML the author embedded', () => {
    const html = renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('does not execute HTML smuggled inline', () => {
    const html = renderMarkdown('text <img src=x onerror=alert(1)> more');
    expect(html).not.toMatch(/onerror/i);
  });

  it('keeps a javascript: link from surviving as a link', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  it('renders fenced code as escaped text, not as markup', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('<pre>');
    // The code is shown, but as entities — never as a live element.
    expect(html).toMatch(/&lt;script&gt;/);
    expect(html).not.toMatch(/<script>/);
  });

  it('handles an empty string without throwing', () => {
    expect(() => renderMarkdown('')).not.toThrow();
  });
});

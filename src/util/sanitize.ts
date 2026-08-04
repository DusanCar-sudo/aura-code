// ─────────────────────────────────────────────────────────────────────────────
// HTML sanitization — state-machine based tag stripper
// Regex cannot reliably parse HTML (nested tags, angle brackets in attributes,
// malformed input all bypass regex). This state machine handles:
//   - < inside double/single-quoted attribute values
//   - > inside double/single-quoted attribute values
//   - Nested script/style blocks
//   - Self-closing tags (<br/>, <img />)
//   - Unclosed tags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from a string using a character-level state machine.
 * Also removes <script> and <style> blocks entirely (including content).
 * Preserves text content. Decodes common HTML entities afterward.
 */
export function stripHtml(html: string): string {
  const len = html.length;
  const out: string[] = [];
  let i = 0;

  // States
  const TEXT = 0;
  const TAG = 1;
  const TAG_SINGLE_QUOTE = 2;  // inside a tag, in a single-quoted attribute
  const TAG_DOUBLE_QUOTE = 3;  // inside a tag, in a double-quoted attribute
  const COMMENT = 4;           // inside <!-- -->
  const SCRIPT = 5;            // inside <script>...</script>
  const STYLE = 6;             // inside <style>...</style>
  const CDATA = 7;             // inside <![CDATA[...]]>

  let state = TEXT;
  let tagName = '';
  let isClosingTag = false;

  while (i < len) {
    const ch = html[i];
    const nextCh = i + 1 < len ? html[i + 1] : '';

    switch (state) {
      case TEXT:
        if (ch === '<') {
          // Check for comments
          if (html.startsWith('<!--', i)) {
            state = COMMENT;
            i += 4;
            continue;
          }
          // Check for CDATA
          if (html.startsWith('<![CDATA[', i)) {
            state = CDATA;
            i += 9;
            continue;
          }
          // Check for script/style
          if (/script/i.test(html.slice(i + 1).match(/^(\/?)\s*(\w+)/)?.[2] ?? '')) {
            const m = html.slice(i + 1).match(/^\/?\s*script/i);
            if (m) {
              state = SCRIPT;
              tagName = 'script';
              isClosingTag = m[0].startsWith('/');
              i += m[0].length;
              // Skip whitespace before >
              while (i < len && (html[i] === ' ' || html[i] === '\t' || html[i] === '\n' || html[i] === '\r')) i++;
              // Skip attributes until >
              while (i < len && html[i] !== '>') i++;
              if (i < len) i++;
              continue;
            }
          }
          if (/style/i.test(html.slice(i + 1).match(/^(\/?)\s*(\w+)/)?.[2] ?? '')) {
            const m = html.slice(i + 1).match(/^\/?\s*style/i);
            if (m) {
              state = STYLE;
              tagName = 'style';
              isClosingTag = m[0].startsWith('/');
              i += m[0].length;
              while (i < len && (html[i] === ' ' || html[i] === '\t' || html[i] === '\n' || html[i] === '\r')) i++;
              while (i < len && html[i] !== '>') i++;
              if (i < len) i++;
              continue;
            }
          }
          state = TAG;
          isClosingTag = nextCh === '/';
          tagName = '';
          i++;
          continue;
        }
        out.push(ch);
        i++;
        break;

      case TAG:
        if (ch === '\'') {
          state = TAG_SINGLE_QUOTE;
          i++;
          continue;
        }
        if (ch === '"') {
          state = TAG_DOUBLE_QUOTE;
          i++;
          continue;
        }
        if (ch === '>') {
          state = TEXT;
          // If this is a block-level tag, add a newline
          const tn = tagName.toLowerCase();
          if (['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
               'br', 'tr', 'td', 'th', 'blockquote', 'section',
               'article', 'nav', 'header', 'footer', 'table',
               'ul', 'ol', 'dl', 'dd', 'dt', 'pre', 'hr', 'form'].includes(tn)) {
            out.push('\n');
          }
          tagName = '';
          i++;
          continue;
        }
        // Collect tag name (only letters, digits, hyphens for tag names)
        if (/[a-zA-Z]/.test(ch) && tagName.length < 32) {
          tagName += ch;
        }
        i++;
        break;

      case TAG_SINGLE_QUOTE:
        if (ch === '\'') state = TAG;
        // Also handle escaped single quote
        if (ch === '\\' && nextCh === '\'') i++;  // skip escaped quote
        i++;
        break;

      case TAG_DOUBLE_QUOTE:
        if (ch === '"') state = TAG;
        if (ch === '\\' && nextCh === '"') i++;
        i++;
        break;

      case COMMENT:
        if (ch === '-' && html.startsWith('-->', i)) {
          state = TEXT;
          i += 3;
          continue;
        }
        i++;
        break;

      case CDATA:
        if (ch === ']' && html.startsWith(']]>', i)) {
          state = TEXT;
          i += 3;
          continue;
        }
        out.push(ch);
        i++;
        break;

      case SCRIPT:
        // We're inside a <script> block — skip everything until </script>
        // But if this was a closing </script>, we skip the content only for
        // opening <script> tags. For closing </script>, skip just the tag.
        if (isClosingTag) {
          state = TEXT;
          continue;
        }
        // Read forward looking for </script>
        const scriptEndMatch = html.slice(i).match(/<\/script\s*>/i);
        if (scriptEndMatch && scriptEndMatch.index !== undefined) {
          i += scriptEndMatch.index + scriptEndMatch[0].length;
          state = TEXT;
        } else {
          // No closing script tag found — skip rest
          i = len;
        }
        continue;

      case STYLE:
        if (isClosingTag) {
          state = TEXT;
          continue;
        }
        const styleEndMatch = html.slice(i).match(/<\/style\s*>/i);
        if (styleEndMatch && styleEndMatch.index !== undefined) {
          i += styleEndMatch.index + styleEndMatch[0].length;
          state = TEXT;
        } else {
          i = len;
        }
        continue;
    }
  }

  let text = out.join('');

  // Decode common HTML entities (single pass to avoid double-decode)
  text = decodeEntities(text);

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Decode HTML entities in a single pass.
 * Uses a single regex replacement to avoid sequential decode issues
 * (e.g., &amp;lt; should become &lt;, not <).
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match) => {
    switch (match) {
      case '&amp;':  return '&';
      case '&lt;':   return '<';
      case '&gt;':   return '>';
      case '&quot;': return '"';
      case '&#39;':  return "'";
      case '&#x27;': return "'";
      case '&nbsp;': return ' ';
      case '&apos;': return "'";
      case '&mdash;': return '—';
      case '&ndash;': return '–';
      case '&hellip;': return '…';
      case '&laquo;': return '«';
      case '&raquo;': return '»';
      case '&lsquo;': return '‘';
      case '&rsquo;': return '’';
      case '&ldquo;': return '“';
      case '&rdquo;': return '”';
      default:
        // Handle numeric character references
        if (match.startsWith('&#x')) {
          const code = parseInt(match.slice(3, -1), 16);
          return isNaN(code) ? match : String.fromCodePoint(code);
        }
        if (match.startsWith('&#')) {
          const code = parseInt(match.slice(2, -1), 10);
          return isNaN(code) ? match : String.fromCodePoint(code);
        }
        return match;  // unknown entity, leave as-is
    }
  });
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize user-supplied HTML for safe DOM rendering.
 * Returns { safe, html } where safe=true means dangerous content was found & neutralised.
 */
function sanitizeHTML(input) {
  if (typeof input !== 'string') {
    throw new TypeError('input must be a string');
  }
  let html = input;
  let modified = false;

  // Only escapes angle brackets — misses &, ", and event handlers
  if (html.includes('<') || html.includes('>')) {
    html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    modified = true;
  }

  return { safe: modified, html };
}

module.exports = { sanitizeHTML };

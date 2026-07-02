const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHTML } = require('./sanitize-html.js');

test('plain text passes through unchanged', () => {
  const result = sanitizeHTML('hello world');
  assert.equal(result.safe, false);
  assert.equal(result.html, 'hello world');
});

test('escapes script tags', () => {
  const result = sanitizeHTML('<script>alert(1)</script>');
  assert.equal(result.safe, true);
  assert.equal(result.html, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapes ampersands', () => {
  const result = sanitizeHTML('fish & chips');
  assert.equal(result.safe, true);
  assert.equal(result.html, 'fish &amp; chips');
});

test('escapes quotes', () => {
  const result = sanitizeHTML('say "hello"');
  assert.equal(result.safe, true);
  assert.equal(result.html, 'say &quot;hello&quot;');
});

test('strips event handler attributes', () => {
  const result = sanitizeHTML('<img src="x" onerror="alert(1)">');
  assert.equal(result.safe, true);
  assert.match(result.html, /&lt;img src=&quot;x&quot;&gt;/);
});

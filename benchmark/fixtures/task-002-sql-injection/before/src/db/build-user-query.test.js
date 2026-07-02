const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUserQuery } = require('./build-user-query.js');

test('returns a parameterized query object, not a raw interpolated string', () => {
  const result = buildUserQuery('alice');
  assert.equal(typeof result, 'object', 'must return {sql, params}, not a raw string');
  assert.match(result.sql, /\$1/, 'sql must use a placeholder, not interpolate the value');
  assert.deepEqual(result.params, ['alice']);
});

test('malicious input never appears inside the sql text', () => {
  const malicious = `'; DROP TABLE users; --`;
  const result = buildUserQuery(malicious);
  assert.ok(!result.sql.includes('DROP TABLE'), 'raw injected SQL must not leak into the query text');
  assert.deepEqual(result.params, [malicious], 'malicious input should be passed as a parameter value only');
});

test('username with quotes does not break query structure', () => {
  const result = buildUserQuery(`o'brien`);
  assert.equal(result.sql, 'SELECT * FROM users WHERE username = $1');
  assert.deepEqual(result.params, [`o'brien`]);
});

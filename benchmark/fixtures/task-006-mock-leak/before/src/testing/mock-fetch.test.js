const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockFetch } = require('./mock-fetch.js');

test('returns correct response for mapped URL', async () => {
  const { fetch } = createMockFetch({
    'https://api.example.com/users': { status: 200, body: [{ id: 1 }] }
  });
  
  const res = await fetch('https://api.example.com/users');
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ id: 1 }]);
});

test('throws on unmapped URL', async () => {
  const { fetch } = createMockFetch({});
  
  try {
    await fetch('https://api.example.com/unknown');
    assert.fail('Should have thrown on unmapped URL');
  } catch (err) {
    assert.ok(err instanceof Error);
  }
});

test('tracks call history in order', async () => {
  const { fetch, calls } = createMockFetch({
    'url1': { body: '1' },
    'url2': { body: '2' }
  });
  
  await fetch('url1', { method: 'POST' });
  await fetch('url2');
  
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { url: 'url1', opts: { method: 'POST' } });
  assert.deepEqual(calls[1], { url: 'url2', opts: undefined });
});

test('restore() cleans up globalThis.fetch', () => {
  const originalFetch = () => 'original';
  globalThis.fetch = originalFetch;
  
  const { fetch, restore } = createMockFetch({});
  globalThis.fetch = fetch; // Patch global
  
  restore(); // Should unpatch
  
  assert.equal(globalThis.fetch, originalFetch, 'globalThis.fetch was not restored');
  delete globalThis.fetch;
});

test('assertAllCalled() throws when a mapped URL was never called', async () => {
  const { assertAllCalled } = createMockFetch({
    'url1': { body: '1' },
    'url2': { body: '2' }
  });
  
  assert.throws(() => {
    assertAllCalled();
  });
});

test('assertAllCalled() passes when all mapped URLs were called', async () => {
  const { fetch, assertAllCalled } = createMockFetch({
    'url1': { body: '1' },
    'url2': { body: '2' }
  });
  
  await fetch('url1');
  await fetch('url2');
  
  assert.doesNotThrow(() => {
    assertAllCalled();
  });
});

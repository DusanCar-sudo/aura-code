const test = require('node:test');
const assert = require('node:assert/strict');
const { LRUCache } = require('./lru-cache.js');

test('get() returns -1 for missing keys', () => {
  const cache = new LRUCache(2);
  assert.equal(cache.get('a'), -1);
});

test('put/get basic round-trip', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  cache.put('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), 2);
});

test('evicts LRU when at capacity', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  cache.put('b', 2);
  cache.put('c', 3); // Should evict 'a'
  
  assert.equal(cache.get('a'), -1);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('get() updates access order', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  cache.put('b', 2);
  cache.get('a'); // 'a' is now most recently used
  cache.put('c', 3); // Should evict 'b', not 'a'
  
  assert.equal(cache.get('b'), -1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('put() on existing key updates value AND access order', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  cache.put('b', 2);
  cache.put('a', 10); // 'a' is updated and is now MRU
  cache.put('c', 3); // Should evict 'b'
  
  assert.equal(cache.get('b'), -1);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('c'), 3);
});

test('size() never exceeds capacity', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  assert.equal(cache.size(), 1);
  cache.put('b', 2);
  assert.equal(cache.size(), 2);
  cache.put('c', 3);
  assert.equal(cache.size(), 2);
});

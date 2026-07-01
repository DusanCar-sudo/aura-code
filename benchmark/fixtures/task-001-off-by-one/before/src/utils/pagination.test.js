const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate } = require('./pagination.js');

const items = Array.from({ length: 10 }, (_, i) => i + 1); // [1..10]

test('page 1 of size 3 returns exactly 3 items', () => {
  assert.deepEqual(paginate(items, 1, 3), [1, 2, 3]);
});

test('page 2 of size 3 returns exactly 3 items, no overlap', () => {
  assert.deepEqual(paginate(items, 2, 3), [4, 5, 6]);
});

test('last partial page returns only remaining items', () => {
  assert.deepEqual(paginate(items, 4, 3), [10]);
});

test('page size exactly divides total items', () => {
  assert.deepEqual(paginate(items, 2, 5), [6, 7, 8, 9, 10]);
});

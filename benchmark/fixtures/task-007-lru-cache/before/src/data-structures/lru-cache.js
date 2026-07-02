/**
 * LRU Cache with O(1) get and put.
 * Uses a Map (insertion-order in JS) as the backing store.
 */
class LRUCache {
  constructor(capacity) {
    if (capacity < 1) throw new RangeError('capacity must be >= 1');
    this._capacity = capacity;
    this._store = new Map();
  }

  /**
   * Returns the value for key, or -1 if not found.
   * BUG: does NOT move the accessed key to most-recently-used position.
   */
  get(key) {
    if (!this._store.has(key)) return -1;
    // Should delete and re-insert to move to end of Map iteration order
    return this._store.get(key);
  }

  /**
   * Insert or update key-value pair.
   * If at capacity, evict one entry.
   */
  put(key, value) {
    if (this._store.has(key)) {
      // BUG: updates value but doesn't move to most-recently-used
      this._store.set(key, value);
      return;
    }

    if (this._store.size >= this._capacity) {
      // BUG: evicts LAST (most recently used) instead of FIRST (least recently used)
      const keys = [...this._store.keys()];
      this._store.delete(keys[keys.length - 1]);
    }

    this._store.set(key, value);
  }

  size() {
    return this._store.size;
  }
}

module.exports = { LRUCache };

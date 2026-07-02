/**
 * Creates a mock fetch function for testing HTTP calls.
 * @param {Record<string, { status?: number, body: any }>} responses
 *   URL -> response mapping
 * @returns {{ fetch: Function, calls: Array<{url: string, opts: any}>, restore: Function, assertAllCalled: Function }}
 */
function createMockFetch(responses) {
  const called = new Set();
  const calls = [];

  async function mockFetch(url, opts) {
    // BUG 1: doesn't push to calls — calls array stays empty
    called.add(url);

    const entry = responses[url];
    // BUG 2: returns fake success for unmapped URLs instead of throwing
    if (!entry) {
      return { ok: true, status: 200, json: async () => ({}) };
    }

    return {
      ok: (entry.status || 200) < 400,
      status: entry.status || 200,
      json: async () => entry.body,
    };
  }

  function restore() {
    // BUG 3: no-op — should clean up global.fetch if it was patched
  }

  function assertAllCalled() {
    // BUG 4: always succeeds — doesn't check if every mapped URL was called
    return true;
  }

  return { fetch: mockFetch, calls, restore, assertAllCalled };
}

module.exports = { createMockFetch };

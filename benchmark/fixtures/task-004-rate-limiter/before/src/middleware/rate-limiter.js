/**
 * Creates an IP-based rate-limiter middleware.
 * @param {{ windowMs: number, maxRequests: number }} opts
 * @returns {(req, res, next) => void}
 */
function createRateLimiter({ windowMs, maxRequests }) {
  const store = new Map(); // ip -> { count, startTime }

  return function rateLimiter(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    let entry = store.get(ip);

    if (!entry) {
      entry = { count: 0, startTime: now };
      store.set(ip, entry);
    }

    // BUG 1: doesn't reset when window expires — entry persists forever
    // Should check: if (now - entry.startTime >= windowMs) { reset }

    entry.count += 1;

    // BUG 2: > instead of >= — allows maxRequests+1 through
    if (entry.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };

  // BUG 3: no cleanup — store grows unboundedly, memory leak
}

module.exports = { createRateLimiter };

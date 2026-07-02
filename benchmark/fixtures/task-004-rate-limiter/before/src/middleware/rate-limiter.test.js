const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout } = require('node:timers/promises');
const { createRateLimiter } = require('./rate-limiter.js');

function createMocks(ip = '1.2.3.4') {
  const req = { ip };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    }
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, getNextCalled: () => nextCalled };
}

test('allows requests under the limit', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
  
  for (let i = 0; i < 2; i++) {
    const { req, res, next, getNextCalled } = createMocks();
    limiter(req, res, next);
    assert.equal(getNextCalled(), true, `Request ${i+1} should be allowed`);
    assert.equal(res.statusCode, null);
  }
});

test('blocks request AT maxRequests + 1', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
  
  // 1
  let m1 = createMocks(); limiter(m1.req, m1.res, m1.next);
  // 2
  let m2 = createMocks(); limiter(m2.req, m2.res, m2.next);
  
  // 3 - should block
  let m3 = createMocks(); limiter(m3.req, m3.res, m3.next);
  assert.equal(m3.getNextCalled(), false);
  assert.equal(m3.res.statusCode, 429);
});

test('window resets after windowMs', async () => {
  const limiter = createRateLimiter({ windowMs: 50, maxRequests: 1 });
  
  let m1 = createMocks(); limiter(m1.req, m1.res, m1.next);
  assert.equal(m1.getNextCalled(), true);
  
  let m2 = createMocks(); limiter(m2.req, m2.res, m2.next);
  assert.equal(m2.getNextCalled(), false);
  
  await setTimeout(60);
  
  let m3 = createMocks(); limiter(m3.req, m3.res, m3.next);
  assert.equal(m3.getNextCalled(), true, 'Should be allowed after window expires');
});

test('different IPs have separate counters', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
  
  let m1 = createMocks('ip1'); limiter(m1.req, m1.res, m1.next);
  assert.equal(m1.getNextCalled(), true);
  
  let m2 = createMocks('ip2'); limiter(m2.req, m2.res, m2.next);
  assert.equal(m2.getNextCalled(), true);
  
  let m3 = createMocks('ip1'); limiter(m3.req, m3.res, m3.next);
  assert.equal(m3.getNextCalled(), false);
});

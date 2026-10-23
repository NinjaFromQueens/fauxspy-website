// Phone-app poll (/api/app-interest): one counted vote per browser, bad
// input rejected, rate limited.  Redis is an in-memory fake.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const store = new Map();
const hashes = new Map();
const lists = new Map();
class FakeRedis {
  async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; }
  async expire() { return 1; }
  async set(k, v, opts = {}) {
    if (opts.nx && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }
  async hincrby(k, field, by) {
    const h = hashes.get(k) || {};
    h[field] = (h[field] || 0) + by;
    hashes.set(k, h);
    return h[field];
  }
  async lpush(k, v) { const l = lists.get(k) || []; l.unshift(v); lists.set(k, l); return l.length; }
  async ltrim() { return 'OK'; }
}
function stub(name, exports) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('@upstash/redis', { Redis: FakeRedis });
stub('resend', { Resend: class { constructor() { this.emails = { send: async () => ({}) }; } } });

const contact = require('../api/contact');

function mockRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}
async function vote(body, ip = '198.51.100.9') {
  const res = mockRes();
  await contact({ method: 'POST', query: { type: 'app-interest' }, headers: { 'x-forwarded-for': ip }, body }, res);
  return res;
}

test('a vote is counted once per browser, with page and device but no IP', async () => {
  const first = await vote({ answer: 'iphone', page: '/tinder', touch: true, userId: 'fs_1761234567890_abc123def' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.counted, true);

  const again = await vote({ answer: 'android', page: '/hinge', touch: true, userId: 'fs_1761234567890_abc123def' });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.counted, false);

  assert.deepEqual(hashes.get('app-interest:counts'), { iphone: 1 });
  const saved = JSON.parse(lists.get('app-interest:responses')[0]);
  assert.equal(saved.answer, 'iphone');
  assert.equal(saved.page, '/tinder');
  assert.equal(saved.touch, true);
  assert.ok(!JSON.stringify(saved).includes('198.51.100.9'));
});

test('unknown answers, bad ids and odd page paths are handled', async () => {
  assert.equal((await vote({ answer: 'maybe', userId: 'fs_1761234567890_x1' })).statusCode, 400);
  assert.equal((await vote({ answer: 'no', userId: 'not-an-id' })).statusCode, 400);
  assert.equal((await vote({ answer: 'no' })).statusCode, 400);

  const odd = await vote({ answer: 'no', page: '<script>', userId: 'fs_1761234567890_oddpage1' });
  assert.equal(odd.statusCode, 200);
  assert.equal(JSON.parse(lists.get('app-interest:responses')[0]).page, null);
});

test('one IP can vote at most 10 times an hour', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await vote({ answer: 'no', userId: `fs_1761234567890_rl${i}x` }, '192.0.2.44');
  assert.equal(last.statusCode, 429);
});

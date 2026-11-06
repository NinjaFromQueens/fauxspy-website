// Phone vs desktop funnel (/api/funnel): counts per day, step and device;
// rejects unknown steps; accepts sendBeacon's text bodies; rate limited;
// stores no IP.  Redis is an in-memory fake.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const store = new Map();
const hashes = new Map();
class FakeRedis {
  async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; }
  async expire() { return 1; }
  async hincrby(k, field, by) {
    const h = hashes.get(k) || {};
    h[field] = (h[field] || 0) + by;
    hashes.set(k, h);
    return h[field];
  }
  async hgetall(k) { return hashes.get(k) || null; }
  pipeline() {
    const ops = [];
    return {
      hgetall: k => ops.push(() => this.hgetall(k)),
      exec: () => Promise.all(ops.map(op => op())),
    };
  }
}
function stub(name, exports) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('@upstash/redis', { Redis: FakeRedis });
stub('resend', { Resend: class { constructor() { this.emails = { send: async () => ({}) }; } } });

const contact = require('../api/contact');
const { readFunnel } = require('../api/_lib/funnel');

function mockRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}
async function send(body, ip = '198.51.100.20') {
  const res = mockRes();
  await contact({ method: 'POST', query: { type: 'funnel' }, headers: { 'x-forwarded-for': ip }, body }, res);
  return res;
}
const today = () => `funnel:${new Date().toISOString().slice(0, 10)}`;

test.beforeEach(() => { store.clear(); hashes.clear(); });

test('each step is counted for the day, split by phone and desktop, with no IP stored', async () => {
  assert.equal((await send({ step: 'check', device: 'phone' })).statusCode, 204);
  await send({ step: 'check', device: 'phone' });
  await send({ step: 'check', device: 'desktop' });
  await send({ step: 'trial', device: 'phone' });
  assert.deepEqual(hashes.get(today()), { 'check:phone': 2, 'check:desktop': 1, 'trial:phone': 1 });
  assert.ok(![...hashes.values()].some(h => JSON.stringify(h).includes('198.51.100.20')));
});

test("sendBeacon's text body is parsed like JSON", async () => {
  assert.equal((await send(JSON.stringify({ step: 'share', device: 'phone' }))).statusCode, 204);
  assert.deepEqual(hashes.get(today()), { 'share:phone': 1 });
});

test('unknown steps, devices and junk are rejected without counting', async () => {
  assert.equal((await send({ step: 'hacked', device: 'phone' })).statusCode, 400);
  assert.equal((await send({ step: 'check', device: 'tablet' })).statusCode, 400);
  assert.equal((await send('not json')).statusCode, 400);
  assert.equal((await send(undefined)).statusCode, 400);
  assert.equal(hashes.size, 0);
});

test('one IP is limited to 300 counts an hour', async () => {
  for (let i = 0; i < 300; i++) await send({ step: 'visit', device: 'phone' }, '203.0.113.5');
  assert.equal((await send({ step: 'visit', device: 'phone' }, '203.0.113.5')).statusCode, 429);
  assert.equal(hashes.get(today())['visit:phone'], 300);
  assert.equal((await send({ step: 'visit', device: 'phone' }, '203.0.113.6')).statusCode, 204);
});

test('only POST is accepted', async () => {
  const res = mockRes();
  await contact({ method: 'GET', query: { type: 'funnel' }, headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('the admin read returns the last 30 days, newest first, with empty days as {}', async () => {
  await send({ step: 'result', device: 'phone' });
  const days = await readFunnel(30);
  assert.equal(days.length, 30);
  assert.equal(days[0].date, new Date().toISOString().slice(0, 10));
  assert.deepEqual(days[0].counts, { 'result:phone': 1 });
  assert.deepEqual(days[1].counts, {});
  assert.ok(days[0].date > days[29].date);
});

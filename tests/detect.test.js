// /api/detect when a provider is down: the outage and the silent Hive
// fallback must both reach Sentry, without the image URL.
// Redis, Sentry, Hive and Sightengine are faked; no network.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DEBUG) console.log = console.warn = console.error = () => {};

Object.assign(process.env, {
  UPSTASH_REST_URL: 'https://fake.upstash.io',
  UPSTASH_REST_TOKEN: 'fake',
  HIVE_API_KEY: 'hive',
  SIGHTENGINE_API_USER: 'user',
  SIGHTENGINE_API_SECRET: 'secret',
});
delete process.env.SUPABASE_URL;

const store = new Map();
class FakeRedis {
  async get(k) { if (!store.has(k)) return null; const v = store.get(k); try { return JSON.parse(v); } catch { return v; } }
  async set(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return 'OK'; }
  async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; }
  async expire() { return 1; }
}
const redisId = require.resolve('@upstash/redis');
require.cache[redisId] = { id: redisId, filename: redisId, loaded: true, exports: { Redis: FakeRedis } };

const sentryEvents = [];
const sentryId = require.resolve('@sentry/node');
require.cache[sentryId] = { id: sentryId, filename: sentryId, loaded: true, exports: {
  init() {}, captureEvent() {}, captureException() {},
  captureMessage(message, ctx) { sentryEvents.push({ message, ...ctx }); },
  flush: async () => true,
} };

const detect = require('../api/detect');

const IMAGE = 'https://cdn.example.com/person-photo.jpg';
let hiveResponse, sightengineResponse;
global.fetch = async (url) => {
  url = String(url);
  if (url.startsWith('https://api.thehive.ai/')) return { json: async () => hiveResponse };
  if (url.startsWith('https://api.sightengine.com/')) return { json: async () => sightengineResponse };
  // The image header (C2PA/EXIF) check: nothing useful there.
  return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
};

async function scan() {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await detect({ method: 'POST', body: { imageUrl: IMAGE, userId: 'fs_test_user', isPro: false, width: 800, height: 800, pageHost: 'example.com' }, headers: {} }, res);
  return res;
}

const HIVE_BAD_KEY = { return_code: 403, message: 'Invalid Auth Token.' };

test.beforeEach(() => {
  store.clear();
  sentryEvents.length = 0;
});

test('both providers down: 503, and a fatal Sentry event without the image URL', async () => {
  hiveResponse = HIVE_BAD_KEY;
  sightengineResponse = { status: 'failure', error: { type: 'usage_limit', code: 32, message: `Monthly limit reached for ${IMAGE}` } };
  const res = await scan();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'SERVICE_UNAVAILABLE');
  const outage = sentryEvents.find(e => e.fingerprint?.[0] === 'detection-outage');
  assert.ok(outage, 'outage reaches Sentry');
  assert.equal(outage.level, 'fatal');
  assert.match(outage.extra.hive, /Invalid Auth Token/);
  assert.match(outage.extra.sightengine, /Monthly limit/);
  assert.ok(!JSON.stringify(outage).includes(IMAGE), 'image URL scrubbed');
});

test('Hive down, Sightengine up: the scan works and Sentry gets a warning', async () => {
  hiveResponse = HIVE_BAD_KEY;
  sightengineResponse = { status: 'success', type: { ai_generated: 0.97, illustration: 0.01, photo: 0.99 } };
  const res = await scan();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const warning = sentryEvents.find(e => e.fingerprint?.[0] === 'hive-failed');
  assert.ok(warning, 'Hive failure reaches Sentry');
  assert.equal(warning.level, 'warning');
  assert.ok(!sentryEvents.some(e => e.fingerprint?.[0] === 'detection-outage'));
});

test('both providers up: nothing sent to Sentry', async () => {
  hiveResponse = { status: [{ response: { output: [{ classes: [{ class: 'ai_generated', score: 0.02 }] }] } }] };
  sightengineResponse = { status: 'success', type: { ai_generated: 0.03, illustration: 0.01, photo: 0.99 } };
  const res = await scan();
  assert.equal(res.statusCode, 200);
  assert.equal(sentryEvents.length, 0);
});

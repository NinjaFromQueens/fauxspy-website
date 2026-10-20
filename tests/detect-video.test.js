// /api/detect-video against Sightengine's documented response shape
// (sightengine.com/docs/ai-generated-video-detection): frames under
// data.frames, each with type.ai_generated and type.ai_generators.
// Redis and Sightengine are faked; no network.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DEBUG) console.log = console.warn = console.error = () => {};

Object.assign(process.env, {
  UPSTASH_REST_URL: 'https://fake.upstash.io',
  UPSTASH_REST_TOKEN: 'fake',
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
const id = require.resolve('@upstash/redis');
require.cache[id] = { id, filename: id, loaded: true, exports: { Redis: FakeRedis } };

const detectVideo = require('../api/detect-video');

const KEY = 'FAUX-ABCD-EFGH-JKMN-PQRS';
let sightengineCalls = 0;
let nextSightengine = null;
global.fetch = async (url, opts) => {
  assert.equal(url, 'https://api.sightengine.com/1.0/video/check-sync.json');
  sightengineCalls++;
  assert.match(String(opts.body), /models=genai/);
  return { json: async () => nextSightengine };
};

function frame(score, generators) {
  return { info: { id: `med_x_${Math.random()}`, position: 0 }, type: { ai_generated: score, ...(generators ? { ai_generators: generators } : {}) } };
}

async function scan(videoUrl = 'https://cdn.example.com/clip.mp4', licenseKey = KEY) {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await detectVideo({ method: 'POST', body: { videoUrl, userId: 'fs_test', licenseKey }, headers: {} }, res);
  return res;
}

test.beforeEach(() => {
  store.clear();
  sightengineCalls = 0;
  store.set(`license:${KEY}`, JSON.stringify({ key: KEY, plan: 'video-monthly', status: 'active', tokenBalance: 500, topupBalance: 0 }));
});

test('an AI video is detected, the generator named, and 10 tokens charged', async () => {
  nextSightengine = {
    status: 'success',
    data: { frames: [
      frame(0.97, { kling: 0.8, wan: 0.1, other: 0.9 }),
      frame(0.93, { kling: 0.7, wan: 0.2, other: 0.9 }),
      frame(0.95, { kling: 0.9, wan: 0.05, other: 0.9 }),
    ] },
  };
  const res = await scan();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.isAIVideo, true);
  assert.equal(res.body.verdict, 'ai_video');
  assert.equal(res.body.framesAnalyzed, 3);
  assert.ok(Math.abs(res.body.aiScore - 0.95) < 1e-9);
  // "other" isn't a generator name, even when it scores highest.
  assert.equal(res.body.topGenerator, 'kling');
  assert.equal(res.body.tokensUsed, 10);
  assert.equal(JSON.parse(store.get(`license:${KEY}`)).tokenBalance, 490);
});

test('a real video comes back as likely real with no generator', async () => {
  nextSightengine = { status: 'success', data: { frames: [frame(0.02), frame(0.05)] } };
  const res = await scan('https://cdn.example.com/real.mp4');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, 'real_video');
  assert.equal(res.body.topGenerator, null);
});

test('the same video is answered from cache without another charge', async () => {
  nextSightengine = { status: 'success', data: { frames: [frame(0.9)] } };
  await scan('https://cdn.example.com/again.mp4');
  const second = await scan('https://cdn.example.com/again.mp4');
  assert.equal(second.body.cached, true);
  assert.equal(sightengineCalls, 1);
  assert.equal(JSON.parse(store.get(`license:${KEY}`)).tokenBalance, 490);
});

test("a reply with no scored frames is an error and costs nothing", async () => {
  nextSightengine = { status: 'success', data: { frames: [] } };
  const res = await scan('https://cdn.example.com/empty.mp4');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'NO_FRAMES');
  assert.equal(JSON.parse(store.get(`license:${KEY}`)).tokenBalance, 500);
});

test('image-only Pro plans are refused before calling Sightengine', async () => {
  store.set(`license:${KEY}`, JSON.stringify({ key: KEY, plan: 'monthly', status: 'active', tokenBalance: 200 }));
  const res = await scan();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'VIDEO_FEATURE_REQUIRED');
  assert.equal(sightengineCalls, 0);
});

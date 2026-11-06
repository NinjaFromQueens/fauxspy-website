// Phone vs desktop funnel: anonymous daily counts of each step from a visit
// to a started trial, plus the home-screen app's installs, opens and shares.
// It answers "where do phone visitors drop off?" and decides whether a
// native app is worth building. Counts only: no user id, IP or page URL is
// stored (the IP is used for a one-hour rate-limit key and nothing else).
// Served at /api/funnel, which vercel.json rewrites to
// /api/contact?type=funnel so it doesn't need its own function.
// Read in the admin dashboard (Phone funnel tab).

const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

const STEPS = new Set([
  'visit', 'check', 'result', 'limit', 'offer', 'offer_click', 'checkout', 'trial',
  'install_prompt', 'install_click', 'installed', 'app_open', 'share',
]);
const DEVICES = new Set(['phone', 'desktop']);
const RATE_LIMIT = 300; // per IP per hour
const KEEP_DAYS = 180;

const dayKey = (d = new Date()) => `funnel:${d.toISOString().slice(0, 10)}`;

async function handleFunnel(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fauxspy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // sendBeacon may arrive as text/plain, which isn't parsed for us.
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { step, device } = body;
  if (!STEPS.has(step) || !DEVICES.has(device)) return res.status(400).json({ error: 'INVALID_EVENT' });

  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) {
      const rlKey = `ratelimit:funnel:${ip}`;
      const count = await kv.incr(rlKey);
      if (count === 1) await kv.expire(rlKey, 3600);
      if (count > RATE_LIMIT) return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' });
    }
    const key = dayKey();
    await kv.hincrby(key, `${step}:${device}`, 1);
    await kv.expire(key, KEEP_DAYS * 86400);
    return res.status(204).end();
  } catch (err) {
    console.error('❌ Funnel count failed:', err.message);
    return res.status(500).json({ error: 'SAVE_FAILED' });
  }
}

// Last `days` days, newest first: [{ date, counts: { 'check:phone': 3, ... } }].
async function readFunnel(days = 30) {
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.now() - i * 86400000));
  const pipe = kv.pipeline();
  dates.forEach(d => pipe.hgetall(dayKey(d)));
  const rows = await pipe.exec();
  return dates.map((d, i) => ({ date: d.toISOString().slice(0, 10), counts: rows[i] || {} }));
}

module.exports = handleFunnel;
module.exports.readFunnel = readFunnel;
module.exports.STEPS = [...STEPS];

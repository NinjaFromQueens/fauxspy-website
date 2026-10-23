// "Would you use a Faux Spy phone app?" poll, asked under a photo-check result
// on the platform pages (/photo-check.js). Answers decide whether a phone app
// is worth building. Stores the answer, page and device type only: no IP or
// email. The anonymous checker id (fs_uid) is kept just to count each
// browser once.
// Served at /api/app-interest, which vercel.json rewrites to
// /api/contact?type=app-interest so it doesn't need its own function.

const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

const ANSWERS = new Set(['iphone', 'android', 'no']);
const COUNTS_KEY = 'app-interest:counts';
const LIST_KEY = 'app-interest:responses';
const MAX_ENTRIES = 5000;
const RATE_LIMIT = 10; // per IP per hour
const VOTE_TTL = 365 * 24 * 3600;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fauxspy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { answer, page, touch, userId } = req.body || {};
  if (typeof answer !== 'string' || !ANSWERS.has(answer)) {
    return res.status(400).json({ error: 'INVALID_ANSWER' });
  }
  if (typeof userId !== 'string' || !/^fs_[A-Za-z0-9_]{4,60}$/.test(userId)) {
    return res.status(400).json({ error: 'INVALID_USER' });
  }

  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) {
      const rlKey = `ratelimit:app-interest:${ip}`;
      const count = await kv.incr(rlKey);
      if (count === 1) await kv.expire(rlKey, 3600);
      if (count > RATE_LIMIT) return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' });
    }

    // One vote per browser; a repeat answer is accepted but not counted.
    const first = await kv.set(`app-interest:voted:${userId}`, answer, { nx: true, ex: VOTE_TTL });
    if (!first) return res.status(200).json({ success: true, counted: false });

    const entry = {
      answer,
      page: typeof page === 'string' && /^\/[a-z0-9-]{1,40}$/.test(page) ? page : null,
      touch: touch === true,
      timestamp: new Date().toISOString(),
    };
    await kv.hincrby(COUNTS_KEY, answer, 1);
    await kv.lpush(LIST_KEY, JSON.stringify(entry));
    await kv.ltrim(LIST_KEY, 0, MAX_ENTRIES - 1);

    return res.status(200).json({ success: true, counted: true });
  } catch (err) {
    console.error('❌ App-interest save failed:', err.message);
    return res.status(500).json({ error: 'SAVE_FAILED' });
  }
};

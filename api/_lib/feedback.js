// Uninstall survey from /goodbye (the extension's setUninstallURL page).
// Stores an anonymous reason + optional comment. No IP, email or user ID.
// Served at /api/feedback, which vercel.json rewrites to /api/contact?type=feedback:
// Vercel's Hobby plan allows 12 functions, so this rides on the contact function.

const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

const REASONS = new Set([
  'not_working', 'wrong_results', 'too_few_scans', 'too_expensive', 'privacy', 'not_needed', 'other',
]);
const LIST_KEY = 'feedback:uninstall';
const MAX_ENTRIES = 1000;
const MAX_TEXT = 1000;
const RATE_LIMIT = 5; // per IP per hour

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fauxspy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reason, text, version, website } = req.body || {};

  // Honeypot — bots fill this field, humans don't see it
  if (website) return res.status(200).json({ success: true });

  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    return res.status(400).json({ error: 'INVALID_REASON' });
  }
  if (text !== undefined && typeof text !== 'string') {
    return res.status(400).json({ error: 'INVALID_TEXT' });
  }

  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) {
      const rlKey = `ratelimit:feedback:${ip}`;
      const count = await kv.incr(rlKey);
      if (count === 1) await kv.expire(rlKey, 3600);
      if (count > RATE_LIMIT) return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' });
    }

    const entry = {
      reason,
      text: (text || '').trim().slice(0, MAX_TEXT),
      version: typeof version === 'string' && /^[0-9.]{1,20}$/.test(version) ? version : null,
      timestamp: new Date().toISOString(),
    };
    await kv.lpush(LIST_KEY, JSON.stringify(entry));
    await kv.ltrim(LIST_KEY, 0, MAX_ENTRIES - 1);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Feedback save failed:', err.message);
    return res.status(500).json({ error: 'SAVE_FAILED' });
  }
};

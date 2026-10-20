// /api/checkout-status.js
// GET ?session_id=cs_... → what a finished checkout produced, for the success
// and buy-tokens pages. The webhook writes checkout:{sessionId} only after a
// signature-verified payment, and session ids are unguessable, so this needs
// no Stripe call.

const { Redis } = require('@upstash/redis');
const { managedPaymentsEnabled } = require('./_lib/stripe');

const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
// The id sits in the success page's URL and browser history; after a day
// the key is only handed out by email from /account.
const KEY_VISIBLE_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT = 120; // per IP per hour: the page polls every 2s for a minute

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionId = req.query.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return res.status(400).json({ error: 'INVALID_SESSION_ID' });
  }

  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) {
      const rlKey = `ratelimit:checkout-status:${ip}`;
      const count = await kv.incr(rlKey);
      if (count === 1) await kv.expire(rlKey, 3600);
      if (count > RATE_LIMIT) return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' });
    }

    const result = await kv.get(`checkout:${sessionId}`);
    if (!result) return res.status(200).json({ status: 'pending' });
    if (Date.now() - result.at > KEY_VISIBLE_MS) return res.status(200).json({ status: 'expired' });

    if (result.kind === 'topup') {
      return res.status(200).json({ status: 'complete', kind: 'topup', tokens: result.tokens, balance: result.balance });
    }
    return res.status(200).json({
      status: 'complete',
      kind: 'subscription',
      licenseKey: result.key,
      plan: result.plan,
      tokensIncluded: result.tokensIncluded,
      trialEndsAt: result.trialEndsAt || null,
      tokenBalance: result.tokenBalance ?? result.tokensIncluded,
      soldThroughLink: managedPaymentsEnabled(),
    });
  } catch (err) {
    console.error('checkout-status error:', err.message);
    return res.status(500).json({ error: 'LOOKUP_FAILED' });
  }
};

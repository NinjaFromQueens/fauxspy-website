// /api/billing-portal.js
// Two steps, so knowing someone's email address isn't enough to open their
// billing (and cancel their plan):
//   POST { email } → emails that address its license key and a 30-minute link
//   POST { token } → exchanges the link's token for a Stripe portal URL
// The email step doubles as lost-key recovery.

const { Redis } = require('@upstash/redis');
const { randomBytes } = require('crypto');
const { sendAccountEmail } = require('./_lib/email');
const { getStripe } = require('./_lib/stripe');

const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

const TOKEN_TTL_S = 30 * 60;
const TOKEN_FORMAT = /^[a-f0-9]{48}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Same reply whether or not the address has a plan, so the form can't be
// used to find out who's a customer.
const SENT = { sent: true, message: "If that email has a Faux Spy plan, we've sent it your license key and a link to manage billing. Check your inbox (and spam folder)." };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fauxspy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, token } = req.body || {};
  try {
    if (typeof token === 'string' && token) return await openPortal(token, res);
    if (typeof email === 'string' && EMAIL_FORMAT.test(email.trim())) {
      return await sendLink(email.trim().toLowerCase(), req, res);
    }
    return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Enter the email address you used at checkout.' });
  } catch (error) {
    console.error('Billing portal error:', error);
    return res.status(500).json({
      error: 'PORTAL_FAILED',
      message: 'Something went wrong on our side. Try again in a minute, or email hello@fauxspy.com.'
    });
  }
};

async function overLimit(key, limit) {
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, 3600);
  return count > limit;
}

async function sendLink(email, req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if ((ip && await overLimit(`ratelimit:account:ip:${ip}`, 10)) ||
      await overLimit(`ratelimit:account:email:${email}`, 3)) {
    return res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Use the link in the last email we sent, or try again in an hour.'
    });
  }

  const licenseKey = await kv.get(`email:${email}`);
  const license = licenseKey ? await kv.get(`license:${licenseKey}`) : null;
  if (license) {
    const token = randomBytes(24).toString('hex');
    await kv.set(`portal_token:${token}`, email, { ex: TOKEN_TTL_S });
    if (!(await sendAccountEmail(email, license, token))) {
      return res.status(500).json({
        error: 'EMAIL_FAILED',
        message: "We couldn't send the email just now. Try again in a minute, or email hello@fauxspy.com."
      });
    }
  }
  return res.status(200).json(SENT);
}

async function openPortal(token, res) {
  // Not deleted on use: mail scanners often open links before the person
  // does. It expires on its own instead.
  const email = TOKEN_FORMAT.test(token) ? await kv.get(`portal_token:${token}`) : null;
  if (!email) {
    return res.status(400).json({
      error: 'LINK_EXPIRED',
      message: 'This link has expired. Enter your email below and we’ll send a new one.'
    });
  }

  const licenseKey = await kv.get(`email:${email}`);
  const license = licenseKey ? await kv.get(`license:${licenseKey}`) : null;
  if (!license?.customerId) {
    return res.status(404).json({
      error: 'NO_CUSTOMER',
      message: 'No billing account found. Email hello@fauxspy.com and we’ll sort it out.'
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_NOT_CONFIGURED', message: 'Billing is temporarily unavailable.' });
  }
  const stripe = getStripe();
  const siteUrl = process.env.SITE_URL || 'https://www.fauxspy.com';
  const session = await stripe.billingPortal.sessions.create({
    customer: license.customerId,
    return_url: `${siteUrl}/account`,
    // The Faux Spy portal settings (cancel, card, invoices, plan switching)
    // live in this configuration, created through the API rather than saved
    // as the account default in the Dashboard.
    ...(process.env.STRIPE_PORTAL_CONFIGURATION ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION } : {}),
  });
  return res.status(200).json({ url: session.url });
}

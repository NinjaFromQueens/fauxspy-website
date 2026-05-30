// /api/newsletter.js
// Newsletter signup endpoint
// Stores emails in Vercel KV + adds to Resend newsletter audience
// Sends confirmation email automatically

const { kv } = require('@vercel/kv');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, website } = req.body || {};

    // Honeypot — bots fill this, humans don't
    if (website) return res.status(200).json({ success: true });

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // ── Check for duplicate ────────────────────────────────────────────────────
    try {
      const existing = await kv.get(`newsletter:${cleanEmail}`);
      if (existing) {
        return res.status(200).json({ success: true, alreadySubscribed: true });
      }
    } catch (e) {
      console.warn('KV read failed:', e.message);
    }

    // ── Save to Redis ──────────────────────────────────────────────────────────
    const record = {
      email: cleanEmail,
      source: req.body?.source || 'website',
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    };

    let kvSuccess = false;
    try {
      await kv.set(`newsletter:${cleanEmail}`, record);
      await kv.sadd('newsletter:all', cleanEmail);
      await kv.incr('newsletter:count');
      kvSuccess = true;
    } catch (e) {
      console.error('KV write failed:', e.message);
    }

    // ── Add to Resend audience ─────────────────────────────────────────────────
    const audienceId = process.env.NEWSLETTER_AUDIENCE_ID;
    if (process.env.RESEND_API_KEY && audienceId) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.contacts.create({ email: cleanEmail, audienceId, unsubscribed: false });
      } catch (e) {
        console.warn('Resend audience add failed:', e.message);
      }
    }

    // ── Confirmation email ─────────────────────────────────────────────────────
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const from = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';
        await resend.emails.send({
          from,
          to: cleanEmail,
          subject: "You're subscribed to the Faux Spy briefing",
          html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.6; color: #1a1f2e; max-width: 600px; margin: 0 auto; padding: 20px; background: #fff; }
    .header { text-align: center; padding: 32px 0 16px; }
    .logo { font-family: Georgia, serif; font-style: italic; font-size: 28px; font-weight: 800; color: #fbbf24; }
    .badge { display: inline-block; padding: 5px 14px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; border-radius: 100px; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin: 12px 0; text-transform: uppercase; }
    .content { padding: 24px; background: #f8fafc; border-radius: 12px; margin: 16px 0; }
    .footer { text-align: center; color: #94a3b8; font-size: 12px; padding: 24px 0 0; border-top: 1px solid #e2e8f0; margin-top: 24px; }
    a { color: #d97706; }
    .cta-btn { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; text-decoration: none; border-radius: 8px; font-weight: 700; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🕵️ Faux Spy</div>
    <div class="badge">Subscribed</div>
  </div>

  <h2 style="margin:0 0 8px;">You're in.</h2>
  <p>Every Thursday you'll get the <strong>AI scam briefing</strong> — new scam tactics, deepfake news, and one detection tip you can actually use. No filler, no product spam.</p>

  <div class="content">
    <p style="margin:0;"><strong>What to expect:</strong></p>
    <p style="margin:8px 0 0;">A short weekly email covering what's happening in the AI-generated fake image/video world. New blog posts when they drop. A tip you can use immediately. That's it.</p>
  </div>

  <p>In the meantime, the extension is free:</p>
  <p><a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" class="cta-btn">🕵️ Add Faux Spy to Chrome</a></p>

  <div class="footer">
    <p>Faux Spy · <a href="https://www.fauxspy.com">fauxspy.com</a></p>
    <p>You signed up at fauxspy.com. Don't want these? <a href="{{unsubscribe_url}}">Unsubscribe</a>.</p>
  </div>
</body>
</html>`,
        });
      } catch (e) {
        console.warn('Confirmation email failed:', e.message);
      }
    }

    console.log('NEW NEWSLETTER SIGNUP:', JSON.stringify(record));
    return res.status(200).json({ success: true, stored: kvSuccess });

  } catch (err) {
    console.error('Newsletter signup error:', err);
    return res.status(500).json({ error: 'Signup failed' });
  }
};

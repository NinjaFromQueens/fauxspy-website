// /api/waitlist.js
// Handles both Pro waitlist signups and newsletter subscriptions.
// Newsletter mode: POST /api/waitlist?list=newsletter (also reachable via /api/newsletter rewrite)
// Waitlist mode:   POST /api/waitlist (default, unchanged behavior)

const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});
const { Resend } = require('resend');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fauxspy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }


  // GET /api/waitlist?count=app — returns current app waitlist count
  if (req.method === 'GET' && req.query.count === 'app') {
    try {
      const count = await kv.get('app-waitlist:count');
      return res.status(200).json({ count: parseInt(count || '0', 10) });
    } catch {
      return res.status(200).json({ count: 0 });
    }
  }

  try {
    const isNewsletter = req.query.list === 'newsletter';
    const isApp = req.query.list === 'app';
    const { email, source, website } = req.body || {};

    // Honeypot — bots fill this field, humans don't see it
    if (website) return res.status(200).json({ success: true });

    // Validate email format
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const prefix = isNewsletter ? 'newsletter' : isApp ? 'app-waitlist' : 'waitlist';
    const audienceId = isNewsletter
      ? process.env.NEWSLETTER_AUDIENCE_ID
      : process.env.RESEND_AUDIENCE_ID;

    // ========================================================================
    // STEP 1: Check for duplicate
    // ========================================================================
    let existing = null;
    try {
      existing = await kv.get(`${prefix}:${cleanEmail}`);
    } catch (kvError) {
      console.warn('⚠️ KV not available, falling back to logs:', kvError.message);
    }

    if (existing) {
      console.log(`ℹ️ Already on ${prefix}:`, cleanEmail);
      return res.status(200).json({
        success: true,
        message: "You're already on the list!",
        alreadySubscribed: true
      });
    }

    // ========================================================================
    // STEP 2: Save to Vercel KV
    // ========================================================================
    const signupData = {
      email: cleanEmail,
      source: source || (isNewsletter ? 'website-newsletter' : 'unknown'),
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown'
    };

    let kvSuccess = false;
    try {
      await kv.set(`${prefix}:${cleanEmail}`, signupData);
      await kv.sadd(`${prefix}:all`, cleanEmail);
      await kv.incr(`${prefix}:count`);
      kvSuccess = true;
      console.log(`✅ Saved to KV (${prefix}):`, cleanEmail);
    } catch (kvError) {
      console.error('❌ KV storage failed:', kvError.message);
    }

    // ========================================================================
    // STEP 3: Add to Resend Audience
    // ========================================================================
    let resendSuccess = false;
    if (process.env.RESEND_API_KEY && audienceId) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.contacts.create({
          email: cleanEmail,
          audienceId,
          unsubscribed: false
        });
        resendSuccess = true;
        console.log(`✅ Added to Resend audience (${prefix}):`, cleanEmail);
      } catch (resendError) {
        console.warn('⚠️ Resend audience add failed:', resendError.message);
      }
    } else {
      console.log(`ℹ️ Resend audience not configured for ${prefix}`);
    }

    // ========================================================================
    // STEP 4: Send confirmation email
    // ========================================================================
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';

        const emailPayload = isApp
          ? {
              from: fromEmail,
              to: cleanEmail,
              subject: "📱 You're on the Faux Spy App waitlist",
              html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; background: #fff; }
    .header { text-align: center; padding: 32px 0 16px; }
    .logo { font-family: Georgia, serif; font-style: italic; font-size: 28px; font-weight: 800; color: #d97706; }
    .badge { display: inline-block; padding: 6px 16px; background: #fbbf24; color: #1a1a1a; border-radius: 100px; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin: 12px 0; text-transform: uppercase; }
    .content { padding: 24px; background: #fffbeb; border-left: 4px solid #fbbf24; border-radius: 0 8px 8px 0; margin: 16px 0; }
    .footer { text-align: center; color: #9ca3af; font-size: 12px; padding: 24px 0 0; border-top: 1px solid #e5e7eb; margin-top: 24px; }
    a { color: #d97706; }
    .cta-btn { display: inline-block; padding: 12px 28px; background: #fbbf24; color: #1a1a1a; text-decoration: none; border-radius: 8px; font-weight: 700; margin: 8px 0; }
    .platform { display: inline-block; padding: 4px 12px; background: #f3f4f6; border-radius: 100px; font-size: 12px; margin: 2px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🕵️ Faux Spy</div>
    <div class="badge">You're on the list</div>
  </div>
  <h2 style="margin:0 0 8px;">You're in — we'll let you know first.</h2>
  <p>Thanks for joining the Faux Spy app waitlist. We're building AI photo detection for your phone — so you can spot fake profiles, deepfakes, and AI-generated images right from your share sheet.</p>
  <div class="content">
    <p style="margin:0 0 8px;"><strong>What to expect:</strong></p>
    <p style="margin:0;">One email when the app launches — your early access link will be in it. That's it. No spam before then.</p>
  </div>
  <p>Platforms: <span class="platform">🍎 iOS</span> <span class="platform">🤖 Android</span></p>
  <p>While you wait, the free Chrome extension does the same thing on your laptop:</p>
  <p><a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" class="cta-btn">🕵️ Add Faux Spy to Chrome — Free</a></p>
  <div class="footer">
    <p>Faux Spy · <a href="https://www.fauxspy.com">fauxspy.com</a></p>
    <p>You signed up at fauxspy.com/app. Don't want these? Just reply "unsubscribe".</p>
  </div>
</body>
</html>`,
            }
          : isNewsletter
          ? {
              from: fromEmail,
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
    <p style="margin:8px 0 0;">A short weekly email covering what's happening in the AI-generated fake image/video world. New blog posts when they drop. A tip you can use immediately.</p>
  </div>
  <p>In the meantime, the extension is free:</p>
  <p><a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" class="cta-btn">🕵️ Add Faux Spy to Chrome</a></p>
  <div class="footer">
    <p>Faux Spy · <a href="https://www.fauxspy.com">fauxspy.com</a></p>
    <p>You signed up at fauxspy.com. Don't want these? <a href="{{unsubscribe_url}}">Unsubscribe</a>.</p>
  </div>
</body>
</html>`,
            }
          : {
              from: fromEmail,
              to: cleanEmail,
              subject: '🕵️ You\'re on the Faux Spy Pro waitlist!',
              html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.6; color: #1a1f2e; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 32px 0; }
    .logo { font-family: Georgia, serif; font-style: italic; font-size: 32px; font-weight: 800; background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .badge { display: inline-block; padding: 6px 14px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; border-radius: 100px; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin: 16px 0; }
    .content { padding: 24px; background: #f8fafc; border-radius: 12px; margin: 16px 0; }
    h1 { font-family: Georgia, serif; font-style: italic; font-size: 28px; }
    .perk { padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
    .perk:last-child { border-bottom: none; }
    .footer { text-align: center; color: #94a3b8; font-size: 13px; padding: 24px 0; }
    a { color: #d97706; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🕵️ Faux Spy</div>
    <div class="badge">WAITLIST CONFIRMED</div>
  </div>
  <h1>You're on the list!</h1>
  <p>Hey there, future Secret Agent 🕵️</p>
  <p>Thanks for joining the Faux Spy Pro waitlist. You're now locked in for early access + your <strong>50% lifetime discount</strong> when Pro launches.</p>
  <div class="content">
    <h3 style="margin-top: 0;">What you've reserved:</h3>
    <div class="perk">✨ <strong>50% off forever</strong> — $4.99/mo instead of $9.99/mo</div>
    <div class="perk">🚀 <strong>Early access</strong> — Try Pro before public launch</div>
    <div class="perk">🎁 <strong>Founding Member badge</strong> — Permanent profile flair</div>
    <div class="perk">🎯 <strong>Deep Dive mode</strong> — Investigate every image on a page</div>
  </div>
  <p><strong>What happens next?</strong></p>
  <p>You'll get one more email — when Pro launches. We'll send your discount code and early access link. That's it. No spam, no nonsense.</p>
  <p>While you wait, you can install the free version:</p>
  <p><a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; text-decoration: none; border-radius: 8px; font-weight: 700;">🕵️ Install Faux Spy Free</a></p>
  <p>Free tier includes:<br>
  • 10 free scans per day<br>
  • Hover, Ctrl+Click, and Right-click detection<br>
  • Works on Instagram, Pinterest, X, and more<br>
  • All detective badges</p>
  <div class="footer">
    <p>Spy on the fakes 🕵️<br>
    <a href="https://fauxspy.com">fauxspy.com</a></p>
    <p style="font-size: 11px;">You received this because you signed up at fauxspy.com/pro<br>
    Don't want these emails? Just reply with "unsubscribe"</p>
  </div>
</body>
</html>
              `.trim(),
            };

        await resend.emails.send(emailPayload);
        console.log('✅ Confirmation email sent:', cleanEmail);
      } catch (emailError) {
        console.warn('⚠️ Confirmation email failed:', emailError.message);
      }
    }

    // ========================================================================
    // STEP 5: Log for backup
    // ========================================================================
    console.log(`🎉 NEW ${prefix.toUpperCase()} SIGNUP:`, JSON.stringify(signupData));

    return res.status(200).json({
      success: true,
      message: "You're on the list! Check your email.",
      stored: kvSuccess,
      emailListed: resendSuccess
    });

  } catch (error) {
    console.error('❌ Signup error:', error);
    return res.status(500).json({
      error: 'Failed to save signup',
      message: error.message
    });
  }
};

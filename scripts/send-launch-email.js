'use strict';

/**
 * Product Hunt Launch Email
 * Sends a broadcast to the entire Resend Audience (waitlist) on launch day.
 *
 * Usage: node scripts/send-launch-email.js
 * Required env: RESEND_API_KEY, RESEND_AUDIENCE_ID
 * Optional env: RESEND_FROM_EMAIL (defaults to "Duron at Faux Spy <duron@fauxspy.com>")
 *
 * IMPORTANT: Never say "go upvote us" — that violates Product Hunt policy.
 * Say "check us out and share your honest opinion."
 */

const { Resend } = require('resend');

const PRODUCT_HUNT_URL = 'https://www.producthunt.com/products/faux-spy?launch=faux-spy';
const EXCLUSIVE_OFFER_URL = 'https://fauxspy.com/pro?promo=PRODUCTHUNT';
const INSTALL_URL = 'https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg';

// Campaign schedule: every day from May 29 through June 12 (14 sends)
const CAMPAIGN_START = new Date('2026-05-29T09:00:00Z');
const daysSinceStart = Math.floor((Date.now() - CAMPAIGN_START) / (1000 * 60 * 60 * 24));

async function main() {
  if (daysSinceStart > 14) {
    console.log(`Campaign ended (day ${daysSinceStart}). Not sending.`);
    process.exit(0);
  }
  console.log(`Campaign day ${daysSinceStart} of 14 — sending...`);

  const missing = ['RESEND_API_KEY', 'RESEND_AUDIENCE_ID'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'Duron at Faux Spy <duron@fauxspy.com>';
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  // Vary subject so follow-up sends don't look like duplicates in spam filters
  const subject = daysSinceStart === 0
    ? "We're live on Product Hunt today 🕵️"
    : "Faux Spy is live on Product Hunt — have you seen it? 🕵️";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1a1f2e; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 32px 0 24px; }
    .logo-text { font-family: Georgia, serif; font-style: italic; font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .ph-badge { display: inline-block; background: #ff6154; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; padding: 5px 12px; border-radius: 100px; margin-top: 12px; text-decoration: none; }
    h1 { font-size: 1.6rem; font-weight: 800; margin: 0 0 1rem; line-height: 1.3; }
    p { margin: 0 0 1rem; font-size: 0.95rem; }
    .cta-btn { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 0.95rem; }
    .offer-box { background: #fffbeb; border: 1.5px solid #fbbf24; border-radius: 12px; padding: 20px 24px; margin: 1.5rem 0; }
    .offer-box p { margin: 0; }
    .divider { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
    .footer { color: #9ca3af; font-size: 12px; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; }
    a { color: #d97706; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-text">🕵️ Faux Spy</div><br>
    <span class="ph-badge">LIVE ON PRODUCT HUNT</span>
  </div>

  <h1>${daysSinceStart === 0 ? "We're live. I'd love your honest opinion." : "We launched on Product Hunt — here's your 30% off."}</h1>

  <p>Hey — it's Duron. You signed up for the Faux Spy Pro waitlist a while back, which means you already believe the problem is real.</p>

  <p>We launched on Product Hunt. If you have a minute, I'd genuinely appreciate you checking out the listing and sharing your honest thoughts — a comment from someone who's actually used the extension means everything.</p>

  <p><a href="${PRODUCT_HUNT_URL}" class="cta-btn">🚀 See Faux Spy on Product Hunt</a></p>

  <p style="font-size:0.85rem;color:#6b7280;margin-top:0.5rem;">Share your experience — good, bad, or anything in between. Real feedback beats cheerleading.</p>

  <hr class="divider">

  <p><strong>Quick reminder — what Faux Spy actually does:</strong></p>

  <p>You right-click any photo in Chrome and find out in seconds whether it's AI-generated or real. Works on Instagram, Tinder, Bumble, Pinterest, X — anywhere images show up.</p>

  <p>Most people think they can spot AI photos by eye. They can't — the new generation of AI images (Midjourney, DALL-E, Sora) fool even the people who built the detectors. Faux Spy runs the image through a model trained specifically to catch them, and gives you a confidence percentage instead of a flat yes/no.</p>

  <p><strong>Why it matters:</strong> Romance scammers, catfishers, and fake influencer accounts now use AI-generated profile photos as a default. One right-click is the difference between getting played and knowing before you invest time or money.</p>

  <div style="background:#f1f5f9;border-radius:10px;padding:16px 20px;margin:1rem 0;">
    <p style="margin:0 0 8px;font-weight:700;">What you get with the free tier:</p>
    <p style="margin:0 0 12px;font-size:0.9rem;color:#374151;">✓ 10 scans/day &nbsp;·&nbsp; Right-click or hover any image &nbsp;·&nbsp; 5-category verdict &nbsp;·&nbsp; Works on 10+ platforms &nbsp;·&nbsp; No account needed</p>
    <p style="margin:0;text-align:center;">
      <a href="${INSTALL_URL}" style="display:inline-block;padding:11px 22px;background:#1a1f2e;color:#fbbf24;text-decoration:none;border-radius:8px;font-weight:700;font-size:0.9rem;border:1.5px solid #fbbf24;">🕵️ Add Faux Spy to Chrome — Free</a>
    </p>
  </div>

  <hr class="divider">

  <div class="offer-box">
    <p><strong>🎁 Launch day deal — 30% off your first payment.</strong></p>
    <p style="margin-top:0.5rem;">Use code <strong>PRODUCTHUNT</strong> at checkout, or click the link below and it applies automatically. Valid through June 12. No gotchas.</p>
    <div style="margin:1rem 0;text-align:center;">
      <div style="display:inline-block;background:#1a1f2e;color:#fbbf24;font-family:monospace;font-size:1.1rem;font-weight:800;letter-spacing:0.15em;padding:10px 24px;border-radius:8px;border:2px solid #fbbf24;">PRODUCTHUNT</div>
    </div>
    <p style="margin-top:0.5rem;"><a href="${EXCLUSIVE_OFFER_URL}">👉 Click here to subscribe with 30% off →</a></p>
  </div>

  <p>Thanks for being here early. It means more than you know.</p>

  <p>— Duron<br><span style="color:#6b7280;font-size:0.875rem;">Founder, Faux Spy</span></p>

  <p style="font-size:0.875rem;color:#6b7280;">PS — If you know anyone who dates online or worries about fake profiles, today's a good day to share the link. No pressure — just if it feels right.</p>

  <div class="footer">
    <p>You received this because you joined the Faux Spy Pro waitlist at <a href="https://fauxspy.com/pro">fauxspy.com/pro</a>.<br>
    To unsubscribe, reply to this email with "unsubscribe" and I'll remove you right away.</p>
  </div>
</body>
</html>`;

  const TIMEOUT = AbortSignal.timeout(30000); // 30s — prevents silent hangs in CI
  const headers = {
    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // Step 0: Check audience size
  const audienceResp = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const audienceData = await audienceResp.json();
  const contactCount = audienceData?.data?.length ?? 'unknown';
  console.log(`Audience has ${contactCount} contact(s)`);

  // Step 1: Send owner copy only on day 0 (already in audience, would get 2 emails otherwise)
  if (daysSinceStart === 0) {
    console.log('Sending owner copy to duroneppsjr7@gmail.com...');
    const ownerResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ from: fromEmail, to: ['duroneppsjr7@gmail.com'], subject, html }),
    });
    const ownerData = await ownerResp.json();
    if (ownerResp.ok) {
      console.log('✅ Owner copy sent:', ownerData.id);
    } else {
      console.error('❌ Owner copy failed:', ownerData);
    }
  }

  // Step 2: Create and send broadcast to full audience
  console.log('Creating broadcast...');
  const createResp = await fetch('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      audience_id: audienceId,
      from: fromEmail,
      subject,
      html,
      name: `PH Launch Day ${daysSinceStart} — ${new Date().toISOString().slice(0, 10)}`,
    }),
  });
  const createData = await createResp.json();
  if (!createResp.ok) {
    console.error('Failed to create broadcast:', createData);
    process.exit(1);
  }

  const broadcastId = createData.id;
  console.log(`Broadcast created: ${broadcastId}`);
  console.log('Sending...');

  const sendResp = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({}),
  });
  const sendData = await sendResp.json();
  if (!sendResp.ok) {
    console.error('Failed to send broadcast:', sendData);
    process.exit(1);
  }

  console.log('✅ Launch email sent successfully.');
  console.log(`   Broadcast ID: ${broadcastId}`);
  console.log(`   Sent at: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Launch email failed:', err.message);
  process.exit(1);
});

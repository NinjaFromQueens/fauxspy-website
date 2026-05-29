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

const PRODUCT_HUNT_URL = 'https://www.producthunt.com/posts/faux-spy';
const EXCLUSIVE_OFFER_URL = 'https://fauxspy.com/pro?promo=PRODUCTHUNT';
const INSTALL_URL = 'https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg';

async function main() {
  const missing = ['RESEND_API_KEY', 'RESEND_AUDIENCE_ID'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'Duron at Faux Spy <duron@fauxspy.com>';
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  const subject = "We're live on Product Hunt today 🕵️";

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
    <span class="ph-badge">LIVE ON PRODUCT HUNT TODAY</span>
  </div>

  <h1>We're live. I'd love your honest opinion.</h1>

  <p>Hey — it's Duron. You signed up for the Faux Spy Pro waitlist a while back, which means you already believe the problem is real.</p>

  <p>Today we launched on Product Hunt. If you have a minute, I'd genuinely appreciate you checking out the listing and sharing your honest thoughts — a comment from someone who's actually used the extension (or tried it today) means everything on launch day.</p>

  <p><a href="${PRODUCT_HUNT_URL}" class="cta-btn">🚀 See Faux Spy on Product Hunt</a></p>

  <p style="font-size:0.85rem;color:#6b7280;margin-top:0.5rem;">Share your experience — good, bad, or anything in between. Real feedback beats cheerleading.</p>

  <hr class="divider">

  <div class="offer-box">
    <p><strong>🎁 Launch day deal — 30% off your first payment.</strong></p>
    <p style="margin-top:0.5rem;">Use code <strong>PRODUCTHUNT</strong> at checkout, or click the link below and it applies automatically. Valid through June 12. No gotchas.</p>
    <div style="margin:1rem 0;text-align:center;">
      <div style="display:inline-block;background:#1a1f2e;color:#fbbf24;font-family:monospace;font-size:1.1rem;font-weight:800;letter-spacing:0.15em;padding:10px 24px;border-radius:8px;border:2px solid #fbbf24;">PRODUCTHUNT</div>
    </div>
    <p style="margin-top:0.5rem;"><a href="${EXCLUSIVE_OFFER_URL}">👉 Click here to subscribe with 30% off →</a></p>
  </div>

  <p>If you haven't installed the free version yet, here's the link: <a href="${INSTALL_URL}">Add FauxSpy to Chrome</a> — 10 free scans/day, no account needed.</p>

  <p>Thanks for being here early. It means more than you know.</p>

  <p>— Duron<br><span style="color:#6b7280;font-size:0.875rem;">Founder, Faux Spy</span></p>

  <p style="font-size:0.875rem;color:#6b7280;">PS — If you know anyone who dates online or worries about fake profiles, today's a good day to share the link. No pressure — just if it feels right.</p>

  <div class="footer">
    <p>You received this because you joined the Faux Spy Pro waitlist at <a href="https://fauxspy.com/pro">fauxspy.com/pro</a>.<br>
    To unsubscribe, reply to this email with "unsubscribe" and I'll remove you right away.</p>
  </div>
</body>
</html>`;

  // Use Resend REST API directly — resend.broadcasts requires SDK v4+
  const headers = {
    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };

  console.log('Creating broadcast...');
  const createResp = await fetch('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      audience_id: audienceId,
      from: fromEmail,
      subject,
      html,
      name: `Product Hunt Launch — ${new Date().toISOString().slice(0, 10)}`,
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

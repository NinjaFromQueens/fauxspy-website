// Transactional emails: license delivery, top-up receipts, and the account
// link that doubles as lost-key recovery. Shared by webhook.js and
// billing-portal.js.

const { Resend } = require('resend');

const SITE = 'https://www.fauxspy.com';

const PLAN_NAMES = {
  monthly:         'Secret Agent (Monthly)',
  yearly:          'Master Spy (Yearly)',
  'video-monthly': 'Pro + Video (Monthly)',
  'video-yearly':  'Pro + Video (Yearly)',
};

function planName(plan) {
  return PLAN_NAMES[plan] || 'Pro';
}

// "200 scans a month", "6,000 tokens a year (1 per image, 10 per video)"
function allowanceText(plan, tokens) {
  const n = Number(tokens || 0).toLocaleString('en-US');
  const period = plan && plan.endsWith('yearly') ? 'a year' : 'a month';
  return plan && plan.startsWith('video')
    ? `${n} tokens ${period} (1 per image, 10 per video)`
    : `${n} scans ${period}`;
}

async function send(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY not set, email not sent:', subject);
    return false;
  }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';
    const { error } = await resend.emails.send({ from, to, subject, html });
    if (error) throw new Error(error.message || String(error));
    return true;
  } catch (err) {
    console.error('❌ Email send failed:', subject, err.message);
    return false;
  }
}

const STYLES = `
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.6; color: #1a1f2e; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 32px 0 8px; }
    .logo { font-family: Georgia, serif; font-style: italic; font-size: 32px; font-weight: 800; color: #d97706; }
    .badge { display: inline-block; padding: 6px 14px; background: #fbbf24; color: #1a1f2e; border-radius: 100px; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin: 16px 0; }
    .license-box { padding: 28px; background: #fef3c7; border-radius: 16px; margin: 24px 0; text-align: center; border: 2px solid #fbbf24; }
    .license-key { font-family: 'Courier New', monospace; font-size: 22px; font-weight: 700; color: #92400e; letter-spacing: 2px; padding: 14px; background: white; border-radius: 8px; display: inline-block; user-select: all; }
    h1 { font-family: Georgia, serif; font-style: italic; font-size: 28px; }
    .step { padding: 14px 16px; background: #f8fafc; border-left: 4px solid #fbbf24; margin: 10px 0; border-radius: 4px; }
    .step-num { font-weight: 800; color: #d97706; }
    .button { display: inline-block; padding: 14px 28px; background: #d97706; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 700; }
    .footer { text-align: center; color: #94a3b8; font-size: 13px; padding: 24px 0; }
    a { color: #d97706; }`;

function keyBox(licenseKey) {
  return `
  <div class="license-box">
    <p style="margin: 0 0 12px 0; font-size: 14px; color: #92400e; font-weight: 600;">YOUR LICENSE KEY</p>
    <div class="license-key">${licenseKey}</div>
  </div>`;
}

const ACTIVATION_STEPS = `
  <div class="step"><span class="step-num">1.</span> Click the Faux Spy icon in your browser's toolbar (Chrome, Edge or Firefox)</div>
  <div class="step"><span class="step-num">2.</span> Open <strong>Settings</strong> (the gear icon)</div>
  <div class="step"><span class="step-num">3.</span> Paste your key under <strong>License Key</strong> and click <strong>Activate Pro</strong></div>`;

async function sendLicenseEmail(email, licenseKey, plan, tokensIncluded) {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>${STYLES}</style></head>
<body>
  <div class="header">
    <div class="logo">🕵️ Faux Spy</div>
    <div class="badge">PRO MEMBER</div>
  </div>

  <h1>Welcome aboard, Secret Agent!</h1>
  <p>Your <strong>${planName(plan)}</strong> plan is active and includes <strong>${allowanceText(plan, tokensIncluded)}</strong>. Keep this key somewhere safe.</p>

  ${keyBox(licenseKey)}

  <h2>Activate it (30 seconds)</h2>
  <p style="color:#475569;">If you activated Pro on the checkout page, you're already set.</p>
  ${ACTIVATION_STEPS}

  <h3>What you've unlocked</h3>
  <ul>
    <li>✅ <strong>${allowanceText(plan, tokensIncluded)}</strong>, no daily cap</li>
    <li>🔍 <strong>Deep Dive mode</strong>: check every image on a page</li>
    <li>📊 <strong>Detective Case Files</strong>: your scan history</li>
    ${plan && plan.startsWith('video') ? '<li>🎬 <strong>AI video detection</strong></li>' : ''}
    <li>💬 <strong>Priority support</strong>: just reply to this email</li>
  </ul>

  <h3>Manage your plan or lost your key?</h3>
  <p>Go to <a href="${SITE}/account">fauxspy.com/account</a> and enter this email address. We'll send you your key and a link to update your card or cancel.</p>

  <div class="footer">
    <p>Spy on the fakes 🕵️<br><a href="${SITE}">fauxspy.com</a></p>
    <p style="font-size: 11px;">Plan: ${planName(plan)} · Issued ${new Date().toLocaleDateString('en-US')}</p>
  </div>
</body>
</html>`;
  return send(email, '🕵️ Your Faux Spy Pro license key', html);
}

async function sendTopUpEmail(email, tokensAdded, newBalance) {
  if (!email) return false;
  const html = `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e2e8f0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; padding: 32px; border: 1px solid #fbbf24;">
    <h2 style="color: #fbbf24; margin: 0 0 16px;">Token top-up confirmed 🕵️</h2>
    <p style="margin: 0 0 12px;"><strong>${tokensAdded} tokens</strong> were added to your Faux Spy account and are ready to use.</p>
    <p style="color: #94a3b8; margin: 0 0 24px;">Top-up balance: <strong style="color: #e2e8f0;">${newBalance} tokens</strong>. Top-up tokens never expire.</p>
    <p style="font-size: 13px; color: #64748b; margin: 0;">
      Questions? Reply to this email or visit <a href="${SITE}/account" style="color: #fbbf24;">fauxspy.com/account</a>
    </p>
  </div>
</body>
</html>`;
  return send(email, `🕵️ ${tokensAdded} tokens added to your Faux Spy account`, html);
}

// Sent from /account. Possession of the inbox is the proof of ownership, so
// this is where the license key and the billing link both go.
async function sendAccountEmail(email, license, token) {
  const active = license.status !== 'cancelled' && license.status !== 'inactive';
  const link = `${SITE}/account?token=${token}`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>${STYLES}</style></head>
<body>
  <div class="header"><div class="logo">🕵️ Faux Spy</div></div>

  <h1>Your Faux Spy account</h1>
  <p>Someone (hopefully you) asked for the license key and billing link for this email address.</p>
  <p>Plan: <strong>${planName(license.plan)}</strong>${active ? '' : ' (no longer active)'}</p>

  ${keyBox(license.key)}

  ${active ? `<h3>Use it in the extension</h3>${ACTIVATION_STEPS}` : ''}

  <h3>Manage billing</h3>
  <p>Update your card, switch plans, download invoices or cancel:</p>
  <p style="text-align:center; margin: 24px 0;"><a class="button" href="${link}">Manage subscription</a></p>
  <p style="font-size: 13px; color: #64748b;">This link works for 30 minutes. If you didn't ask for it, you can ignore this email.</p>

  <div class="footer"><p><a href="${SITE}">fauxspy.com</a></p></div>
</body>
</html>`;
  return send(email, 'Your Faux Spy license key and account link', html);
}

module.exports = { sendLicenseEmail, sendTopUpEmail, sendAccountEmail, allowanceText, planName };

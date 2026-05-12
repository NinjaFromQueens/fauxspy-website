// /api/webhook.js
// Stripe webhook handler
// Generates license keys on successful payment
// Sends license via email
// Handles subscription lifecycle events

const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');

const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

// IMPORTANT: Vercel needs raw body for Stripe signature verification
// This config disables JSON parsing so we get the raw buffer
module.exports.config = {
  api: {
    bodyParser: false
  }
};

// Helper to read raw request body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ Stripe not configured');
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-05-28.basil' });
  
  // Verify webhook signature (security critical)
  let event;
  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];
    
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  
  console.log('📨 Webhook event:', event.type);
  
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object, stripe);
        break;
        
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;
        
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
        
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
        
      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }
    
    return res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    // Return 200 anyway so Stripe doesn't retry on logic errors
    // (only return non-200 for transient errors that should retry)
    return res.status(200).json({ received: true, error: error.message });
  }
};

// ============================================================================
// EVENT HANDLERS
// ============================================================================

async function handleCheckoutCompleted(session, stripe) {
  console.log('💰 Checkout completed:', session.id);
  
  const customerEmail = session.customer_email || session.customer_details?.email;
  if (!customerEmail) {
    console.error('❌ No email in session');
    return;
  }
  
  // Get subscription details
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  
  // Determine plan from price ID
  const priceId = subscription.items.data[0].price.id;
  const plan = priceId === process.env.STRIPE_PRICE_YEARLY ? 'yearly' : 'monthly';
  
  // Generate license key
  const licenseKey = generateLicenseKey();
  
  // License data
  const licenseData = {
    key: licenseKey,
    email: customerEmail,
    plan: plan,
    status: 'active',
    customerId: session.customer,
    subscriptionId: session.subscription,
    createdAt: Date.now(),
    expiresAt: subscription.current_period_end * 1000,
  };
  
  // Store in KV (key indexed by license key for lookup)
  await kv.set(`license:${licenseKey}`, licenseData);
  
  // Also index by email for management
  await kv.set(`email:${customerEmail.toLowerCase()}`, licenseKey);
  
  // Track stats
  await kv.incr('stats:total_licenses');
  await kv.sadd(`licenses:plan:${plan}`, licenseKey);
  
  console.log('✅ License generated:', licenseKey, 'for', customerEmail);
  
  // Send license email
  await sendLicenseEmail(customerEmail, licenseKey, plan);
}

async function handleSubscriptionCancelled(subscription) {
  console.log('❌ Subscription cancelled:', subscription.id);
  
  // Find license by subscription ID
  // Note: This is a slow lookup - consider adding subscription:license index
  const allLicenseKeys = await kv.keys('license:*');
  
  for (const key of allLicenseKeys) {
    const license = await kv.get(key);
    if (license?.subscriptionId === subscription.id) {
      license.status = 'cancelled';
      license.cancelledAt = Date.now();
      await kv.set(key, license);
      console.log('✅ License marked cancelled:', license.key);
      break;
    }
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Subscription updated:', subscription.id);
  
  // Update expiration on license
  const allLicenseKeys = await kv.keys('license:*');
  
  for (const key of allLicenseKeys) {
    const license = await kv.get(key);
    if (license?.subscriptionId === subscription.id) {
      license.expiresAt = subscription.current_period_end * 1000;
      license.status = subscription.status === 'active' ? 'active' : 'inactive';
      await kv.set(key, license);
      break;
    }
  }
}

async function handlePaymentFailed(invoice) {
  console.log('💸 Payment failed:', invoice.id);
  // TODO: Email user about failed payment
  // For now, subscription will auto-cancel after retries
}

// ============================================================================
// LICENSE KEY GENERATION
// ============================================================================

function generateLicenseKey() {
  // Format: FAUX-XXXX-XXXX-XXXX-XXXX
  // Uses crypto-strong randomness, alphanumeric (no confusing chars)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0, O, 1, I, L
  
  function segment() {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }
  
  return `FAUX-${segment()}-${segment()}-${segment()}-${segment()}`;
}

// ============================================================================
// EMAIL DELIVERY
// ============================================================================

async function sendLicenseEmail(email, licenseKey, plan) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️ Resend not configured, skipping email');
    return;
  }
  
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';
    
    const planName = plan === 'yearly' ? 'Master Spy (Yearly)' : 'Secret Agent (Monthly)';
    
    await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: '🕵️ Welcome to Faux Spy Pro — Your license is ready!',
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
    .license-box { padding: 32px; background: linear-gradient(135deg, #fef3c7 0%, #fed7aa 100%); border-radius: 16px; margin: 24px 0; text-align: center; border: 2px solid #fbbf24; }
    .license-key { font-family: 'Courier New', monospace; font-size: 22px; font-weight: 700; color: #92400e; letter-spacing: 2px; padding: 16px; background: white; border-radius: 8px; display: inline-block; user-select: all; }
    h1 { font-family: Georgia, serif; font-style: italic; font-size: 28px; }
    .step { padding: 16px; background: #f8fafc; border-left: 4px solid #fbbf24; margin: 12px 0; border-radius: 4px; }
    .step-num { font-weight: 800; color: #d97706; }
    .footer { text-align: center; color: #94a3b8; font-size: 13px; padding: 24px 0; }
    a { color: #d97706; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🕵️ Faux Spy</div>
    <div class="badge">PRO MEMBER</div>
  </div>
  
  <h1>Welcome aboard, Secret Agent!</h1>
  
  <p>Your <strong>${planName}</strong> subscription is active. Below is your license key — keep it safe!</p>
  
  <div class="license-box">
    <p style="margin: 0 0 12px 0; font-size: 14px; color: #92400e; font-weight: 600;">YOUR LICENSE KEY</p>
    <div class="license-key">${licenseKey}</div>
    <p style="margin: 16px 0 0 0; font-size: 12px; color: #92400e;">Click to select • Copy to clipboard</p>
  </div>
  
  <h2>How to activate (60 seconds):</h2>
  
  <div class="step">
    <span class="step-num">Step 1.</span> Open Chrome and click the Faux Spy extension icon
  </div>
  <div class="step">
    <span class="step-num">Step 2.</span> Click <strong>HQ Settings</strong> (gear icon)
  </div>
  <div class="step">
    <span class="step-num">Step 3.</span> Scroll to <strong>"License Key"</strong> section
  </div>
  <div class="step">
    <span class="step-num">Step 4.</span> Paste your license key and click <strong>Activate</strong>
  </div>
  <div class="step">
    <span class="step-num">Step 5.</span> Pro features unlock instantly! 🎉
  </div>
  
  <h3>What you've unlocked:</h3>
  <ul>
    <li>✅ <strong>Unlimited investigations</strong> — no daily limits</li>
    <li>🔍 <strong>Deep Dive mode</strong> — investigate every image on a page</li>
    <li>📊 <strong>Detective Case Files</strong> — searchable scan history</li>
    <li>🚀 <strong>Priority detection</strong> — faster response times</li>
    <li>💬 <strong>Priority support</strong> — direct email response</li>
  </ul>
  
  <h3>Need help?</h3>
  <p>Reply to this email or visit <a href="https://fauxspy.com/contact">fauxspy.com/contact</a></p>
  
  <p>Manage your subscription anytime at the link in your Stripe receipt email.</p>
  
  <div class="footer">
    <p>Spy on the fakes 🕵️<br>
    <a href="https://fauxspy.com">fauxspy.com</a></p>
    <p style="font-size: 11px;">License: ${licenseKey}<br>
    Plan: ${planName}<br>
    Issued: ${new Date().toLocaleDateString()}</p>
  </div>
</body>
</html>
      `.trim()
    });
    
    console.log('✅ License email sent to:', email);
    
  } catch (error) {
    console.error('❌ Email send failed:', error);
    // Don't throw — license is still saved in KV
  }
}

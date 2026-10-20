// /api/webhook.js
// Stripe webhook handler
// Generates license keys on successful payment
// Sends license via email
// Handles subscription lifecycle events

const { Redis } = require('@upstash/redis');
const { getStripe } = require('./_lib/stripe');
const { generateLicenseKey } = require('./_lib/license');
const { sendLicenseEmail, sendTopUpEmail } = require('./_lib/email');

// Upstash Redis — used for license/subscription data (Stripe webhook handlers)
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

// ============================================================================
// RESEND INBOUND EMAIL HANDLER
// Routed here via vercel.json rewrite: /api/resend-inbound → /api/webhook?source=resend-inbound
// ============================================================================

function verifyResendSignature(rawBody, headers, secret) {
  if (!secret) return false; // Fail closed — if secret is not configured, reject all requests

  const msgId = headers['svix-id'];
  const msgTimestamp = headers['svix-timestamp'];
  const msgSignature = headers['svix-signature'];

  if (!msgId || !msgTimestamp || !msgSignature) return false;

  // Reject if timestamp is more than 5 minutes old (replay attack prevention)
  const tsSeconds = parseInt(msgTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - tsSeconds) > 300) return false;

  // Compute expected signature: HMAC-SHA256(key, "{id}.{timestamp}.{body}")
  const { createHmac } = require('crypto');
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const toSign = `${msgId}.${msgTimestamp}.${rawBody.toString()}`;
  const computed = createHmac('sha256', keyBytes).update(toSign).digest('base64');

  // svix-signature may contain multiple space-separated "v1,<sig>" values
  return msgSignature.split(' ').some(part => {
    const sig = part.replace(/^v\d+,/, '');
    return sig === computed;
  });
}

async function handleResendInbound(req, res) {
  try {
    const rawBody = await getRawBody(req);

    // Verify Resend webhook signature
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (secret && !verifyResendSignature(rawBody, req.headers, secret)) {
      console.warn('Resend inbound: invalid signature — request rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(200).json({ ok: true }); // Return 200 always so Resend doesn't retry
    }

    // Resend wraps email metadata under payload.data
    const emailData = payload.data || {};
    const emailId = emailData.email_id;

    if (!emailId) {
      console.warn('Resend inbound: no email_id in payload, skipping');
      return res.status(200).json({ ok: true });
    }

    // Deduplication — Resend uses at-least-once delivery, so retries can arrive
    const dedupKey = `inbox:dedup:${emailId}`;
    const alreadyDone = await kv.get(dedupKey);
    if (alreadyDone) {
      console.log('Resend inbound: duplicate', emailId, '— skipping');
      return res.status(200).json({ ok: true });
    }

    // Fetch full email content (text/html/headers are NOT included in the webhook)
    let fullEmail = {};
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      try {
        const apiResp = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (apiResp.ok) fullEmail = await apiResp.json();
        else console.warn('Resend receiving API returned', apiResp.status, 'for', emailId);
      } catch (e) {
        console.warn('Resend receiving API fetch failed:', e.message);
      }
    }

    // Parse sender — Resend sends "Name <email>" or just "email"
    const fromRaw = emailData.from || fullEmail.from || '';
    const fromMatch = fromRaw.match(/^(.+?)\s*<([^>]+)>$/);
    const fromName = fromMatch ? fromMatch[1].trim() : '';
    const fromEmail = fromMatch ? fromMatch[2].trim() : fromRaw.trim();

    if (!fromEmail) {
      console.warn('Resend inbound: no sender email, skipping');
      return res.status(200).json({ ok: true });
    }

    const subject = emailData.subject || fullEmail.subject || '(no subject)';
    const text = fullEmail.text || '';
    const html = fullEmail.html || '';

    // fullEmail.headers is an array of {name, value} objects
    const hdrs = Array.isArray(fullEmail.headers) ? fullEmail.headers : [];
    const messageId = emailData.message_id || hdrs.find(h => h.name === 'Message-ID')?.value || '';
    const inReplyTo = hdrs.find(h => h.name === 'In-Reply-To')?.value || '';
    const timestamp = emailData.created_at || new Date().toISOString();

    const id = `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, from: fromEmail, fromName, subject, text, html, messageId, inReplyTo, timestamp, status: 'unread' };

    await kv.set(`inbox:${id}`, record);
    await kv.sadd('inbox:all', id);
    await kv.incr('inbox:unread');
    await kv.set(dedupKey, '1', { ex: 60 * 60 * 24 * 30 }); // 30-day TTL

    console.log('📥 Inbound email stored:', id, 'from:', fromEmail, 'subject:', subject);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Resend inbound error:', err.message);
    return res.status(200).json({ ok: true }); // Always 200 to prevent retries
  }
}

module.exports = async (req, res) => {
  // Route inbound email webhooks before Stripe processing
  if (req.query.source === 'resend-inbound') {
    return handleResendInbound(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ Stripe not configured');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const stripe = getStripe();

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

  console.log('📨 Webhook event:', event.type, event.id);

  // Stripe redelivers an event until it gets a 2xx, for up to 3 days. The
  // event is only marked done after its handler succeeds, so a crash halfway
  // through a paid order is retried instead of lost.
  const dedupKey = `processed_event:${event.id}`;
  try {
    if (await kv.get(dedupKey)) {
      console.log('⏭️ Duplicate event, skipping:', event.id);
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (redisErr) {
    console.warn('⚠️ Redis dedup check failed (processing anyway):', redisErr.message);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        // The Stripe account also sells other products (SmartContractAuditor.ai,
        // TxnGuide...), and every endpoint receives every checkout. Only
        // sessions create-checkout.js tagged as Faux Spy are ours.
        if (!FAUX_SPY_PRODUCTS.has(session.metadata?.product)) {
          console.log('ℹ️ Ignoring checkout for another product:', session.id, session.metadata?.product);
          break;
        }
        // Bank-debit style payments complete checkout before the money
        // arrives; those are fulfilled on async_payment_succeeded instead.
        if (session.payment_status === 'unpaid') break;
        if (session.mode === 'payment') {
          await handleTopUpCompleted(session);
        } else {
          await handleCheckoutCompleted(session, stripe);
        }
        break;
      }

      case 'invoice.payment_succeeded':
        await handleInvoicePaid(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    console.error('❌ Webhook handler error:', event.type, event.id, error);
    return res.status(500).json({ error: 'Handler failed, Stripe will retry' });
  }

  try {
    await kv.set(dedupKey, 1, { ex: 7 * DAY_S });
  } catch (redisErr) {
    console.warn('⚠️ Could not mark event processed:', redisErr.message);
  }
  return res.status(200).json({ received: true });
};

// ============================================================================
// EVENT HANDLERS
// ============================================================================

const DAY_S = 24 * 60 * 60;
// metadata.product values create-checkout.js puts on Faux Spy sessions.
const FAUX_SPY_PRODUCTS = new Set(['faux-spy', 'faux-spy-topup']);
// How long checkout:{sessionId} lives. The success page reads it right after
// payment; the top-up claim must outlast Stripe's 3 days of retries.
const CHECKOUT_MARKER_TTL_S = 7 * DAY_S;

// Token allowances per plan
const TOKENS_PER_PLAN = {
  monthly:       parseInt(process.env.TOKENS_PER_MONTH_MONTHLY)  || 200,
  yearly:        parseInt(process.env.TOKENS_PER_YEAR_YEARLY)    || 2500,
  'video-monthly': parseInt(process.env.TOKENS_VIDEO_MONTHLY)    || 500,
  'video-yearly':  parseInt(process.env.TOKENS_VIDEO_YEARLY)     || 6000,
};

// A free trial gets a taste, not the whole month: someone who cancels before
// the first charge shouldn't have used a full allowance for free. The plan's
// full allowance arrives with the first paid invoice.
const TRIAL_TOKENS = parseInt(process.env.TRIAL_TOKENS) || 50;

// past_due: the card failed and Stripe is retrying it. Keep Pro working
// meanwhile; if the retries run out Stripe cancels and we get .deleted.
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

// Event payloads are rendered in the API version set on the webhook endpoint
// in the Stripe dashboard, not the SDK's. API 2025-03-31.basil moved these
// two fields, so read both places.
function periodEndMs(subscription) {
  const end = subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end;
  return end ? end * 1000 : null;
}

function invoiceSubscriptionId(invoice) {
  const sub = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  return typeof sub === 'string' ? sub : sub?.id || null;
}

function planFromSubscription(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const byPrice = {
    [process.env.STRIPE_PRICE_MONTHLY]: 'monthly',
    [process.env.STRIPE_PRICE_YEARLY]: 'yearly',
    [process.env.STRIPE_VIDEO_MONTHLY_PRICE_ID]: 'video-monthly',
    [process.env.STRIPE_VIDEO_YEARLY_PRICE_ID]: 'video-yearly',
  };
  if (priceId && byPrice[priceId]) return byPrice[priceId];
  // create-checkout.js stamps the plan on the subscription. Price ids win
  // because a plan switch in the billing portal doesn't update metadata.
  const metaPlan = subscription.metadata?.plan;
  if (TOKENS_PER_PLAN[metaPlan]) return metaPlan;
  // Throwing returns a 500, so Stripe keeps retrying: once the missing
  // STRIPE_PRICE_* variable is set, the license still gets created.
  throw new Error(`Unknown price ${priceId} on subscription ${subscription.id}; check the STRIPE_PRICE_* env vars`);
}

async function handleCheckoutCompleted(session, stripe) {
  console.log('💰 Checkout completed:', session.id);

  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) throw new Error(`No email on checkout session ${session.id}`);

  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const plan = planFromSubscription(subscription);
  const tokensIncluded = TOKENS_PER_PLAN[plan];
  const trialEndsAt = subscription.status === 'trialing' && subscription.trial_end ? subscription.trial_end * 1000 : null;
  const openingBalance = trialEndsAt ? TRIAL_TOKENS : tokensIncluded;

  // Claim the subscription atomically so a redelivered (or concurrently
  // delivered) event reuses the first key instead of minting a second one.
  let licenseKey = generateLicenseKey();
  const claimed = await kv.set(`subscription:${subscription.id}`, licenseKey, { nx: true });
  if (!claimed) licenseKey = await kv.get(`subscription:${subscription.id}`);

  const isNew = !(await kv.get(`license:${licenseKey}`));
  if (isNew) {
    await kv.set(`license:${licenseKey}`, {
      key: licenseKey,
      email: customerEmail,
      plan,
      status: 'active',
      customerId: session.customer,
      subscriptionId: subscription.id,
      createdAt: Date.now(),
      expiresAt: periodEndMs(subscription),
      trialEndsAt,
      tokenBalance: openingBalance,
      tokensIncluded,
      topupBalance: 0,
      lastTokenRefresh: Date.now(),
    });
    await kv.set(`email:${customerEmail.toLowerCase()}`, licenseKey);
    await kv.incr('stats:total_licenses');
    await kv.sadd(`licenses:plan:${plan}`, licenseKey);
    console.log('✅ License generated:', licenseKey, 'plan:', plan);
  }

  // Read by /api/checkout-status so the success page can show the key.
  await kv.set(`checkout:${session.id}`, {
    kind: 'subscription', key: licenseKey, plan, tokensIncluded, trialEndsAt, tokenBalance: openingBalance, at: Date.now(),
  }, { ex: CHECKOUT_MARKER_TTL_S });

  // The key is also on the success page and at /account, so a failed email
  // is logged rather than failing the order.
  if (isNew) await sendLicenseEmail(customerEmail, licenseKey, plan, tokensIncluded, { trialEndsAt, trialTokens: openingBalance });
}

async function handleSubscriptionCancelled(subscription) {
  console.log('❌ Subscription cancelled:', subscription.id);

  const licenseKey = await kv.get(`subscription:${subscription.id}`);
  if (!licenseKey) {
    console.warn('⚠️ No license found for subscription:', subscription.id);
    return;
  }

  const license = await kv.get(`license:${licenseKey}`);
  if (license) {
    license.status = 'cancelled';
    license.cancelledAt = Date.now();
    await kv.set(`license:${licenseKey}`, license);
    console.log('✅ License marked cancelled:', licenseKey);
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Subscription updated:', subscription.id);

  const licenseKey = await kv.get(`subscription:${subscription.id}`);
  if (!licenseKey) {
    console.warn('⚠️ No license found for subscription:', subscription.id);
    return;
  }

  const license = await kv.get(`license:${licenseKey}`);
  if (!license) return;

  const plan = planFromSubscription(subscription);
  const tokensIncluded = TOKENS_PER_PLAN[plan];
  const trialing = subscription.status === 'trialing';
  // Upgraded mid-cycle (e.g. Pro to Pro + Video in the billing portal):
  // grant the bigger allowance now, not at the next renewal. Not during a
  // trial, or switching plans would unlock more free tokens.
  if (!trialing && tokensIncluded > (license.tokensIncluded || 0)) {
    license.tokenBalance = (license.tokenBalance || 0) + tokensIncluded - (license.tokensIncluded || 0);
  }
  license.plan = plan;
  license.tokensIncluded = tokensIncluded;
  license.expiresAt = periodEndMs(subscription) || license.expiresAt;
  license.trialEndsAt = trialing && subscription.trial_end ? subscription.trial_end * 1000 : null;
  // A deleted subscription can't come back, so a late, out-of-order update
  // mustn't reactivate it.
  if (license.status !== 'cancelled') {
    license.status = ACTIVE_STATUSES.has(subscription.status) ? 'active' : 'inactive';
  }
  await kv.set(`license:${licenseKey}`, license);
}

async function handleInvoicePaid(invoice) {
  console.log('🔄 Invoice paid:', invoice.id);

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return; // One-time payment, e.g. a top-up
  // The first invoice is paid at checkout ($0 when a trial starts), and the
  // checkout handler already set the opening balance. Refilling here would
  // hand a trial the full allowance.
  if (invoice.billing_reason === 'subscription_create') return;

  const licenseKey = await kv.get(`subscription:${subscriptionId}`);
  if (!licenseKey) {
    // The first invoice can land before checkout.session.completed; that
    // handler creates the license with a full allowance.
    console.warn('⚠️ No license found for subscription:', subscriptionId);
    return;
  }

  const license = await kv.get(`license:${licenseKey}`);
  if (!license) {
    console.warn('⚠️ License data not found:', licenseKey);
    return;
  }

  // Reset subscription tokens but preserve top-up balance
  const tokensIncluded = license.tokensIncluded || TOKENS_PER_PLAN[license.plan] || 200;
  license.tokenBalance = tokensIncluded;
  license.lastTokenRefresh = Date.now();
  await kv.set(`license:${licenseKey}`, license);

  console.log(`✅ Tokens refreshed for ${licenseKey}: ${tokensIncluded} tokens`);
}

async function handleTopUpCompleted(session) {
  console.log('💎 Top-up checkout completed:', session.id);

  const licenseKey = session.metadata?.licenseKey;
  const packSize = parseInt(session.metadata?.packSize);

  if (!licenseKey || !packSize || packSize <= 0) {
    console.error('❌ Missing or invalid licenseKey/packSize in top-up metadata');
    return;
  }

  // Only the first delivery of a session adds tokens. The claim is released
  // if crediting fails, so Stripe's retry can try again.
  const claimKey = `topup_claim:${session.id}`;
  if (!(await kv.set(claimKey, 1, { nx: true, ex: CHECKOUT_MARKER_TTL_S }))) {
    console.log('⏭️ Top-up already credited:', session.id);
    return;
  }

  let license;
  try {
    license = await kv.get(`license:${licenseKey}`);
    if (!license) {
      // create-checkout checks the key before charging, so this means the
      // license was deleted in between. Needs a manual refund.
      console.error('❌ License not found for paid top-up, refund needed:', licenseKey, session.id);
      return;
    }

    license.topupBalance = (license.topupBalance || 0) + packSize;
    await kv.set(`license:${licenseKey}`, license);
    await kv.set(`checkout:${session.id}`, {
      kind: 'topup', key: licenseKey, tokens: packSize,
      balance: (license.tokenBalance || 0) + license.topupBalance, at: Date.now(),
    }, { ex: CHECKOUT_MARKER_TTL_S });
  } catch (err) {
    await kv.del(claimKey).catch(() => {});
    throw err;
  }

  console.log(`✅ Added ${packSize} top-up tokens to ${licenseKey}. New top-up balance: ${license.topupBalance}`);

  await sendTopUpEmail(license.email, packSize, license.topupBalance);
}

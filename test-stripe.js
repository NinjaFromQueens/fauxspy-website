// Checks the live Stripe setup that payments depend on. Read-only apart from
// one checkout session, which expires unused.
//
// Run with production env vars:  npx vercel env pull .env.local && node test-stripe.js

require('dotenv').config({ path: '.env.local' });

const Stripe = require('stripe');
const { generateLicenseKey, KEY_FORMAT } = require('./api/_lib/license');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-05-28.basil' });

const PRICES = [
  ['STRIPE_PRICE_MONTHLY', 'month'],
  ['STRIPE_PRICE_YEARLY', 'year'],
  ['STRIPE_VIDEO_MONTHLY_PRICE_ID', 'month'],
  ['STRIPE_VIDEO_YEARLY_PRICE_ID', 'year'],
  ['STRIPE_PRICE_TOPUP_SMALL', null],
  ['STRIPE_PRICE_TOPUP_MEDIUM', null],
  ['STRIPE_PRICE_TOPUP_LARGE', null],
];
const WEBHOOK_URL = 'https://www.fauxspy.com/api/webhook';
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'invoice.payment_succeeded',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

async function run() {
  const results = [];

  function pass(name) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  function fail(name, err) { results.push({ name, ok: false, err }); console.log(`  ✗ ${name}: ${err}`); }

  console.log('\n── Faux Spy Stripe setup check ──\n');

  // 1. Env vars present
  console.log('1. Environment variables');
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', ...PRICES.map(([k]) => k)]) {
    process.env[key] ? pass(key) : fail(key, 'missing');
  }

  // 2. Stripe connectivity
  console.log('\n2. Stripe API connectivity');
  try {
    const account = await stripe.accounts.retrieve();
    const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';
    pass(`Connected to ${account.id} (${mode} mode)`);
  } catch (e) {
    fail('Stripe connectivity', e.message);
  }

  // 3. Prices exist, are active, and are the right kind
  console.log('\n3. Prices');
  for (const [envVar, interval] of PRICES) {
    const priceId = process.env[envVar];
    if (!priceId) continue;
    try {
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active) throw new Error('price is inactive');
      if ((price.recurring?.interval || null) !== interval) {
        throw new Error(`expected ${interval ? `a ${interval}ly subscription` : 'a one-time'} price, got ${price.recurring?.interval || 'one-time'}`);
      }
      pass(`${envVar}: $${(price.unit_amount / 100).toFixed(2)}${interval ? `/${interval}` : ' one-time'}`);
    } catch (e) {
      fail(envVar, e.message);
    }
  }

  // 4. Webhook endpoint is registered for the events the code handles
  console.log('\n4. Webhook endpoint');
  try {
    const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
    const endpoint = data.find(w => w.url === WEBHOOK_URL || w.url === WEBHOOK_URL.replace('www.', ''));
    if (!endpoint) {
      fail('Webhook endpoint', `none registered for ${WEBHOOK_URL}`);
    } else {
      endpoint.status === 'enabled' ? pass(`${endpoint.url} is enabled (API ${endpoint.api_version || 'account default'})`) : fail('Webhook endpoint', `status ${endpoint.status}`);
      if (endpoint.url !== WEBHOOK_URL) console.log('    note: fauxspy.com redirects to www; point the endpoint at the www address to avoid a redirect');
      const all = endpoint.enabled_events.includes('*');
      for (const ev of WEBHOOK_EVENTS) {
        all || endpoint.enabled_events.includes(ev) ? pass(`sends ${ev}`) : fail(`sends ${ev}`, 'not enabled on the endpoint');
      }
    }
  } catch (e) {
    fail('Webhook endpoint lookup', e.message);
  }
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  whsec?.startsWith('whsec_') ? pass('Webhook secret format') : fail('Webhook secret', 'should start with whsec_');

  // 5. Customer portal lets people manage their plan
  console.log('\n5. Customer portal');
  try {
    const { data } = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
    const features = data[0]?.features;
    if (!features) {
      fail('Customer portal', 'not configured (Stripe → Settings → Billing → Customer portal)');
    } else {
      features.payment_method_update?.enabled ? pass('Customers can update their card') : fail('Portal: update card', 'disabled');
      features.subscription_cancel?.enabled ? pass('Customers can cancel') : fail('Portal: cancel', 'disabled');
      features.invoice_history?.enabled ? pass('Customers can see invoices') : fail('Portal: invoices', 'disabled');
    }
  } catch (e) {
    fail('Customer portal lookup', e.message);
  }

  // 6. A checkout session can be created with the monthly price
  console.log('\n6. Checkout session creation');
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_MONTHLY, quantity: 1 }],
      success_url: 'https://www.fauxspy.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.fauxspy.com/pro?cancelled=true',
      allow_promotion_codes: true,
      metadata: { product: 'faux-spy', plan: 'monthly' },
      subscription_data: { metadata: { product: 'faux-spy', plan: 'monthly' } },
    });
    pass(`Session created: ${session.id}`);
    await stripe.checkout.sessions.expire(session.id).catch(() => {});
  } catch (e) {
    fail('Create checkout session', e.message);
  }

  // 7. The real key generator produces keys the extension accepts
  console.log('\n7. License key generation');
  const key = generateLicenseKey();
  KEY_FORMAT.test(key) && key.length === 24 ? pass(`Generated: ${key}`) : fail('License key format', key);

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });

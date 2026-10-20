// Checks the live Stripe setup that payments depend on. Read-only apart from
// one checkout session, which expires unused.
//
// Run with production env vars:  npx vercel env pull .env.local && node test-stripe.js

require('dotenv').config({ path: '.env.local' });

const { generateLicenseKey, KEY_FORMAT } = require('./api/_lib/license');
const { getStripe, managedPayments, STRIPE_API_VERSION } = require('./api/_lib/stripe');

const stripe = getStripe();
// Stripe Managed Payments needs one of its eligible digital-goods tax codes on
// every product; this is the one that describes Faux Spy.
const EXPECTED_TAX_CODE = 'txcd_10105003'; // AI as a Service, cloud-based & downloaded, personal use

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
  // Bank payments (offered at checkout) clear days later; the order is
  // fulfilled on this event, not on checkout.session.completed.
  'checkout.session.async_payment_succeeded',
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

  // 2. API key
  console.log('\n2. API key');
  const apiKey = process.env.STRIPE_SECRET_KEY || '';
  const mode = apiKey.includes('_live_') ? 'LIVE' : 'TEST';
  apiKey.startsWith('rk_')
    ? pass(`Restricted key (${mode} mode), API ${STRIPE_API_VERSION}`)
    : fail('Restricted key', `this is a full secret key (${apiKey.slice(0, 7)}…); create a restricted key with only the permissions the site needs`);
  console.log(`    Managed Payments (Stripe as merchant of record): ${managedPayments().managed_payments ? 'ON' : 'off (STRIPE_MANAGED_PAYMENTS not "true")'}`);

  // 3. Prices exist, are the right kind, and are set up for Managed Payments
  console.log('\n3. Prices');
  for (const [envVar, interval] of PRICES) {
    const priceId = process.env[envVar];
    if (!priceId) continue;
    try {
      const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
      if (!price.active) throw new Error('price is inactive');
      if ((price.recurring?.interval || null) !== interval) {
        throw new Error(`expected ${interval ? `a ${interval}ly subscription` : 'a one-time'} price, got ${price.recurring?.interval || 'one-time'}`);
      }
      pass(`${envVar}: $${(price.unit_amount / 100).toFixed(2)}${interval ? `/${interval}` : ' one-time'} (${price.product.name})`);
      price.product.tax_code === EXPECTED_TAX_CODE
        ? pass(`  tax code ${EXPECTED_TAX_CODE}`)
        : fail(`  ${envVar} tax code`, `product "${price.product.name}" has ${price.product.tax_code || 'no tax code'}; set ${EXPECTED_TAX_CODE}`);
      // Prices include tax: "inclusive", or unspecified so the account's
      // "Include tax in prices" setting applies. "exclusive" can't be changed
      // on an existing price; it needs a new one.
      price.tax_behavior === 'exclusive'
        ? fail(`  ${envVar} tax behavior`, 'price adds tax on top (exclusive); create a replacement price with tax included and update the env var')
        : pass(`  tax behavior ${price.tax_behavior}${price.tax_behavior === 'unspecified' ? ' (follows "Include tax in prices" in Tax settings)' : ''}`);
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
    const configId = process.env.STRIPE_PORTAL_CONFIGURATION;
    const config = configId
      ? await stripe.billingPortal.configurations.retrieve(configId)
      : (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data[0];
    const features = config?.features;
    if (!features) {
      fail('Customer portal', 'not configured: set STRIPE_PORTAL_CONFIGURATION, or save the portal in Stripe → Settings → Billing → Customer portal');
    } else if (!config.active) {
      fail('Customer portal', `${config.id} is inactive`);
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
      ...managedPayments(),
      metadata: { product: 'faux-spy', plan: 'monthly' },
      subscription_data: { trial_period_days: 7, metadata: { product: 'faux-spy', plan: 'monthly' } },
    });
    pass(`Session created with the same settings as the site: ${session.id}`);
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

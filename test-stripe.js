// End-to-end Stripe integration test
// Run with: node test-stripe.js

require('dotenv').config({ path: '.env.local' });

const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-05-28.basil' });

async function run() {
  const results = [];

  function pass(name) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  function fail(name, err) { results.push({ name, ok: false, err }); console.log(`  ✗ ${name}: ${err}`); }

  console.log('\n── Faux Spy Stripe End-to-End Test ──\n');

  // 1. Env vars present
  console.log('1. Environment variables');
  const required = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY', 'STRIPE_WEBHOOK_SECRET'];
  for (const key of required) {
    process.env[key] ? pass(key) : fail(key, 'missing');
  }

  // 2. Stripe connectivity
  console.log('\n2. Stripe API connectivity');
  try {
    const account = await stripe.accounts.retrieve();
    pass(`Connected to account: ${account.email || account.id}`);
  } catch (e) {
    fail('Stripe connectivity', e.message);
  }

  // 3. Prices exist and are active
  console.log('\n3. Price IDs');
  for (const [label, priceId] of [['Monthly', process.env.STRIPE_PRICE_MONTHLY], ['Yearly', process.env.STRIPE_PRICE_YEARLY]]) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active) throw new Error('price is inactive');
      const amount = (price.unit_amount / 100).toFixed(2);
      pass(`${label}: ${priceId} — $${amount}/${price.recurring?.interval}`);
    } catch (e) {
      fail(`${label} price`, e.message);
    }
  }

  // 4. Create a checkout session (monthly)
  console.log('\n4. Checkout session creation');
  let sessionId;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_MONTHLY, quantity: 1 }],
      success_url: 'http://localhost:3000/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'http://localhost:3000/pro?cancelled=true',
      allow_promotion_codes: true,
      metadata: { product: 'faux-spy', plan: 'monthly' },
      subscription_data: { metadata: { product: 'faux-spy', plan: 'monthly' } },
    });
    sessionId = session.id;
    pass(`Session created: ${session.id}`);
    pass(`Checkout URL: ${session.url.substring(0, 60)}...`);
  } catch (e) {
    fail('Create checkout session', e.message);
  }

  // 5. Create checkout session (yearly)
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_YEARLY, quantity: 1 }],
      success_url: 'http://localhost:3000/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'http://localhost:3000/pro?cancelled=true',
      allow_promotion_codes: true,
      metadata: { product: 'faux-spy', plan: 'yearly' },
      subscription_data: { metadata: { product: 'faux-spy', plan: 'yearly' } },
    });
    pass(`Yearly session created: ${session.id}`);
  } catch (e) {
    fail('Create yearly checkout session', e.message);
  }

  // 6. Webhook secret format
  console.log('\n5. Webhook secret');
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  whsec?.startsWith('whsec_') ? pass(`Webhook secret present (${whsec.length} chars)`) : fail('Webhook secret', 'invalid format');

  // 7. License key generation (unit test)
  console.log('\n6. License key generation');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function segment() {
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  const key = `FAUX-${segment()}-${segment()}-${segment()}-${segment()}`;
  const validFormat = /^FAUX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
  validFormat ? pass(`Generated: ${key}`) : fail('License key format', key);

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });

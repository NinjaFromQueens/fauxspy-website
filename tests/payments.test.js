// Payment flow tests: webhook → license → success page → account recovery.
// Redis, Stripe and Resend are replaced with in-memory fakes, so this never
// touches the network or production data.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

if (!process.env.DEBUG) console.log = console.warn = console.error = () => {};

Object.assign(process.env, {
  UPSTASH_REST_URL: 'https://fake.upstash.io',
  UPSTASH_REST_TOKEN: 'fake',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  STRIPE_PRICE_MONTHLY: 'price_monthly',
  STRIPE_PRICE_YEARLY: 'price_yearly',
  STRIPE_VIDEO_MONTHLY_PRICE_ID: 'price_video_monthly',
  STRIPE_VIDEO_YEARLY_PRICE_ID: 'price_video_yearly',
  STRIPE_PRICE_TOPUP_SMALL: 'price_topup_small',
  STRIPE_PRICE_TOPUP_MEDIUM: 'price_topup_medium',
  STRIPE_PRICE_TOPUP_LARGE: 'price_topup_large',
  RESEND_API_KEY: 're_fake',
});

// ── Fakes ─────────────────────────────────────────────────────────────────────

// Mimics @upstash/redis: objects are stored as JSON, strings as-is, and get()
// JSON-parses when it can.
const store = new Map();
class FakeRedis {
  async get(k) {
    if (!store.has(k)) return null;
    const v = store.get(k);
    try { return JSON.parse(v); } catch { return v; }
  }
  async set(k, v, opts = {}) {
    if (opts.nx && store.has(k)) return null;
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    return 'OK';
  }
  async del(k) { return store.delete(k) ? 1 : 0; }
  async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; }
  async expire() { return 1; }
  async sadd() { return 1; }
}

const subscriptions = new Map();
const stripeCalls = { checkout: [], portal: [], retrieveFailures: 0 };

// Parameters Stripe rejects on a Managed Payments Checkout Session
// (docs.stripe.com/payments/managed-payments/update-checkout), plus
// billing_address_collection, which we leave to Stripe. Any checkout the site
// creates must work with Managed Payments switched on.
const MANAGED_PAYMENTS_FORBIDDEN = [
  'automatic_tax', 'tax_id_collection', 'adaptive_pricing', 'payment_method_types', 'payment_method_configuration',
  'excluded_payment_method_types', 'customer_update', 'shipping_address_collection', 'shipping_options',
  'invoice_creation', 'billing_address_collection',
];
function assertManagedPaymentsCompatible(params) {
  for (const k of MANAGED_PAYMENTS_FORBIDDEN) assert.ok(!(k in params), `checkout session must not set ${k}`);
  for (const k of ['invoice_settings', 'default_tax_rates', 'application_fee_percent', 'on_behalf_of', 'transfer_data']) {
    assert.ok(!(k in (params.subscription_data || {})), `checkout session must not set subscription_data.${k}`);
  }
  for (const k of ['receipt_email', 'statement_descriptor', 'statement_descriptor_suffix', 'shipping']) {
    assert.ok(!(k in (params.payment_intent_data || {})), `checkout session must not set payment_intent_data.${k}`);
  }
  assert.ok(!(params.customer && params.customer_email), 'customer and customer_email are mutually exclusive');
}
function FakeStripe() {
  return {
    webhooks: {
      constructEvent(raw, sig) {
        if (sig !== 'valid') throw new Error('bad signature');
        return JSON.parse(raw.toString());
      },
    },
    subscriptions: {
      async retrieve(id) {
        if (stripeCalls.retrieveFailures > 0) { stripeCalls.retrieveFailures--; throw new Error('Stripe is down'); }
        if (!subscriptions.has(id)) throw new Error(`No such subscription: ${id}`);
        return subscriptions.get(id);
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          assertManagedPaymentsCompatible(params);
          stripeCalls.checkout.push(params);
          return { id: 'cs_test_created', url: 'https://checkout.stripe.com/c/pay/cs_test_created' };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          stripeCalls.portal.push(params);
          return { url: 'https://billing.stripe.com/p/session/test_123' };
        },
      },
    },
    promotionCodes: { async list() { return { data: [] }; } },
  };
}

const sentEmails = [];
class FakeResend {
  constructor() {
    this.emails = { send: async (msg) => { sentEmails.push(msg); return { data: { id: 'email_1' }, error: null }; } };
  }
}

function stub(name, exports) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('@upstash/redis', { Redis: FakeRedis });
stub('stripe', FakeStripe);
stub('resend', { Resend: FakeResend });

const webhook = require('../api/webhook');
const createCheckout = require('../api/create-checkout');
const checkoutStatus = require('../api/checkout-status');
const billingPortal = require('../api/billing-portal');
const validateLicense = require('../api/validate-license');
const { generateLicenseKey, KEY_FORMAT } = require('../api/_lib/license');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function call(handler, { method = 'POST', body, query = {}, ip = '203.0.113.7' } = {}) {
  const res = mockRes();
  await handler({ method, body, query, headers: { 'x-forwarded-for': ip } }, res);
  return res;
}

let eventSeq = 0;
async function sendEvent(type, object, id = `evt_${++eventSeq}`) {
  const req = Readable.from([Buffer.from(JSON.stringify({ id, type, data: { object } }))]);
  req.method = 'POST';
  req.query = {};
  req.headers = { 'stripe-signature': 'valid' };
  const res = mockRes();
  await webhook(req, res);
  return res;
}

const PERIOD_END = Math.floor(Date.UTC(2026, 11, 1) / 1000);

// Basil API shape (current): period end lives on the subscription item.
const TRIAL_END = Math.floor(Date.UTC(2026, 9, 27) / 1000);

function addSubscription(id, priceId, { legacy = false, metadata = {}, status = 'active' } = {}) {
  const sub = {
    id, status, metadata,
    ...(status === 'trialing' ? { trial_end: TRIAL_END } : {}),
    items: { data: [{ price: { id: priceId }, ...(legacy ? {} : { current_period_end: PERIOD_END }) }] },
    ...(legacy ? { current_period_end: PERIOD_END } : {}),
  };
  subscriptions.set(id, sub);
  return sub;
}

function checkoutSession(id, subId, email = 'buyer@example.com') {
  return {
    id, mode: 'subscription', payment_status: 'paid', subscription: subId,
    customer: 'cus_123', customer_details: { email },
  };
}

function licenseKeys() {
  return [...store.keys()].filter(k => k.startsWith('license:'));
}

async function buy(sessionId, subId, priceId = 'price_monthly', email) {
  addSubscription(subId, priceId);
  const res = await sendEvent('checkout.session.completed', checkoutSession(sessionId, subId, email));
  assert.equal(res.statusCode, 200);
  return store.get(`subscription:${subId}`);
}

test.beforeEach(() => {
  store.clear();
  subscriptions.clear();
  sentEmails.length = 0;
  stripeCalls.checkout.length = 0;
  stripeCalls.portal.length = 0;
  stripeCalls.retrieveFailures = 0;
});

// ── License keys ──────────────────────────────────────────────────────────────

test('generated keys match the format every validator and extension accepts', () => {
  for (let i = 0; i < 2000; i++) {
    const key = generateLicenseKey();
    assert.match(key, KEY_FORMAT);
    // The extension's key box cuts input at 24 characters.
    assert.equal(key.length, 24);
    assert.doesNotMatch(key.slice(5), /[01OIL]/);
  }
});

// ── Webhook: new subscription ─────────────────────────────────────────────────

test('checkout.session.completed creates a working license', async () => {
  const key = await buy('cs_test_a1b2c3d4e5f6', 'sub_1');

  assert.match(key, KEY_FORMAT);
  const license = JSON.parse(store.get(`license:${key}`));
  assert.equal(license.plan, 'monthly');
  assert.equal(license.status, 'active');
  assert.equal(license.tokenBalance, 200);
  assert.equal(license.expiresAt, PERIOD_END * 1000);
  assert.equal(store.get('email:buyer@example.com'), key);

  const marker = JSON.parse(store.get('checkout:cs_test_a1b2c3d4e5f6'));
  assert.equal(marker.key, key);
  assert.equal(marker.kind, 'subscription');

  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'buyer@example.com');
  assert.ok(sentEmails[0].html.includes(key));
  assert.ok(sentEmails[0].html.includes('200 scans a month'));
  assert.ok(!/unlimited/i.test(sentEmails[0].html));

  // The license it created passes /api/validate-license.
  const res = await call(validateLicense, { body: { licenseKey: key } });
  assert.equal(res.body.valid, true);
  assert.equal(res.body.plan, 'monthly');
});

test('pre-basil subscription payloads still get an expiry date', async () => {
  addSubscription('sub_legacy', 'price_yearly', { legacy: true });
  await sendEvent('checkout.session.completed', checkoutSession('cs_test_legacy0001', 'sub_legacy'));
  const license = JSON.parse(store.get(`license:${store.get('subscription:sub_legacy')}`));
  assert.equal(license.expiresAt, PERIOD_END * 1000);
  assert.equal(license.plan, 'yearly');
  assert.equal(license.tokenBalance, 2500);
});

test('a redelivered event is skipped, and a second event for the same session reuses the key', async () => {
  addSubscription('sub_2', 'price_monthly');
  const session = checkoutSession('cs_test_dup0000001', 'sub_2');
  await sendEvent('checkout.session.completed', session, 'evt_same');
  const again = await sendEvent('checkout.session.completed', session, 'evt_same');
  assert.equal(again.body.duplicate, true);

  // e.g. async_payment_succeeded after completed, or a concurrent delivery
  await sendEvent('checkout.session.async_payment_succeeded', session, 'evt_other');

  assert.equal(licenseKeys().length, 1);
  assert.equal(sentEmails.length, 1);
});

test('a failing handler returns 500 so Stripe retries, and the retry succeeds', async () => {
  addSubscription('sub_3', 'price_monthly');
  stripeCalls.retrieveFailures = 1;
  const session = checkoutSession('cs_test_retry00001', 'sub_3');

  const first = await sendEvent('checkout.session.completed', session, 'evt_retry');
  assert.equal(first.statusCode, 500);
  assert.equal(store.has('processed_event:evt_retry'), false);
  assert.equal(licenseKeys().length, 0);

  const retry = await sendEvent('checkout.session.completed', session, 'evt_retry');
  assert.equal(retry.statusCode, 200);
  assert.equal(licenseKeys().length, 1);
  assert.equal(store.has('processed_event:evt_retry'), true);
});

test('an unknown price fails loudly instead of selling the wrong plan', async () => {
  addSubscription('sub_4', 'price_unknown');
  const res = await sendEvent('checkout.session.completed', checkoutSession('cs_test_unknown001', 'sub_4'));
  assert.equal(res.statusCode, 500);
  assert.equal(licenseKeys().length, 0);
});

test('plan metadata is the fallback when the price id is not configured', async () => {
  addSubscription('sub_5', 'price_renamed', { metadata: { plan: 'video-yearly' } });
  await sendEvent('checkout.session.completed', checkoutSession('cs_test_meta000001', 'sub_5'));
  const license = JSON.parse(store.get(`license:${store.get('subscription:sub_5')}`));
  assert.equal(license.plan, 'video-yearly');
  assert.equal(license.tokenBalance, 6000);
});

test('an unpaid (delayed) checkout is not fulfilled yet', async () => {
  addSubscription('sub_6', 'price_monthly');
  const session = { ...checkoutSession('cs_test_unpaid0001', 'sub_6'), payment_status: 'unpaid' };
  const res = await sendEvent('checkout.session.completed', session);
  assert.equal(res.statusCode, 200);
  assert.equal(licenseKeys().length, 0);
});

// ── Webhook: renewals and changes ─────────────────────────────────────────────

async function useTokens(key, balance) {
  const license = JSON.parse(store.get(`license:${key}`));
  license.tokenBalance = balance;
  store.set(`license:${key}`, JSON.stringify(license));
}

test('renewal invoices refill tokens (basil and pre-basil shapes)', async () => {
  const key = await buy('cs_test_renew00001', 'sub_7');

  await useTokens(key, 3);
  await sendEvent('invoice.payment_succeeded', { id: 'in_1', parent: { subscription_details: { subscription: 'sub_7' } } });
  assert.equal(JSON.parse(store.get(`license:${key}`)).tokenBalance, 200);

  await useTokens(key, 3);
  await sendEvent('invoice.payment_succeeded', { id: 'in_2', subscription: 'sub_7' });
  assert.equal(JSON.parse(store.get(`license:${key}`)).tokenBalance, 200);
});

test('upgrading in the portal grants the bigger allowance right away', async () => {
  const key = await buy('cs_test_upgrade001', 'sub_8');
  await useTokens(key, 50);

  const sub = addSubscription('sub_8', 'price_video_monthly');
  await sendEvent('customer.subscription.updated', sub);

  const license = JSON.parse(store.get(`license:${key}`));
  assert.equal(license.plan, 'video-monthly');
  assert.equal(license.tokensIncluded, 500);
  assert.equal(license.tokenBalance, 350);
  const res = await call(validateLicense, { body: { licenseKey: key } });
  assert.equal(res.body.features.videoDetection, true);
});

test('a failed card keeps Pro while Stripe retries; cancellation ends it for good', async () => {
  const key = await buy('cs_test_status0001', 'sub_9');
  const sub = subscriptions.get('sub_9');

  await sendEvent('customer.subscription.updated', { ...sub, status: 'past_due' });
  assert.equal(JSON.parse(store.get(`license:${key}`)).status, 'active');

  await sendEvent('customer.subscription.updated', { ...sub, status: 'unpaid' });
  assert.equal(JSON.parse(store.get(`license:${key}`)).status, 'inactive');

  await sendEvent('customer.subscription.deleted', { ...sub, status: 'canceled' });
  // A late, out-of-order update must not bring it back.
  await sendEvent('customer.subscription.updated', { ...sub, status: 'active' });
  assert.equal(JSON.parse(store.get(`license:${key}`)).status, 'cancelled');
  const res = await call(validateLicense, { body: { licenseKey: key } });
  assert.equal(res.body.valid, false);
});

// ── Top-ups ───────────────────────────────────────────────────────────────────

function topUpSession(id, key, packSize = 200) {
  return {
    id, mode: 'payment', payment_status: 'paid',
    metadata: { product: 'faux-spy-topup', licenseKey: key, packSize: String(packSize) },
  };
}

test('a top-up is credited exactly once', async () => {
  const key = await buy('cs_test_forTopup01', 'sub_10');
  const session = topUpSession('cs_test_topup00001', key);

  await sendEvent('checkout.session.completed', session, 'evt_t1');
  await sendEvent('checkout.session.completed', session, 'evt_t2');

  const license = JSON.parse(store.get(`license:${key}`));
  assert.equal(license.topupBalance, 200);
  const marker = JSON.parse(store.get('checkout:cs_test_topup00001'));
  assert.equal(marker.kind, 'topup');
  assert.equal(marker.balance, 400);
});

test('checkout refuses top-ups for unknown or cancelled keys before charging', async () => {
  let res = await call(createCheckout, { body: { mode: 'topup', packSize: 'small', licenseKey: 'FAUX-AAAA-BBBB-CCCC-DDDD' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'LICENSE_NOT_FOUND');

  const key = await buy('cs_test_cancelled1', 'sub_11');
  await sendEvent('customer.subscription.deleted', subscriptions.get('sub_11'));
  res = await call(createCheckout, { body: { mode: 'topup', packSize: 'small', licenseKey: key } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'LICENSE_INACTIVE');
  assert.equal(stripeCalls.checkout.length, 0);
});

test('checkout creates a top-up session for an active key', async () => {
  const key = await buy('cs_test_activeKey1', 'sub_12');
  const res = await call(createCheckout, { body: { mode: 'topup', packSize: 'medium', licenseKey: key.toLowerCase() } });
  assert.equal(res.statusCode, 200);
  assert.equal(stripeCalls.checkout[0].metadata.licenseKey, key);
  assert.equal(stripeCalls.checkout[0].metadata.packSize, '200');
});

test('checkout validates pack size and reports a missing price as a server problem', async () => {
  const key = await buy('cs_test_packs00001', 'sub_13');
  let res = await call(createCheckout, { body: { mode: 'topup', packSize: '__proto__', licenseKey: key } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'INVALID_PACK_SIZE');

  const saved = process.env.STRIPE_PRICE_TOPUP_LARGE;
  delete process.env.STRIPE_PRICE_TOPUP_LARGE;
  try {
    res = await call(createCheckout, { body: { mode: 'topup', packSize: 'large', licenseKey: key } });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'TOPUP_PRICE_NOT_CONFIGURED');
  } finally {
    process.env.STRIPE_PRICE_TOPUP_LARGE = saved;
  }
});

test('subscription checkout sends buyers to the success page', async () => {
  const res = await call(createCheckout, { body: { plan: 'yearly' } });
  assert.equal(res.statusCode, 200);
  assert.equal(stripeCalls.checkout[0].line_items[0].price, 'price_yearly');
  assert.match(stripeCalls.checkout[0].success_url, /\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/);
});

// ── Success page lookup ───────────────────────────────────────────────────────

test('checkout-status: pending, then the key, then expired after a day', async () => {
  const sessionId = 'cs_test_status00001';
  let res = await call(checkoutStatus, { method: 'GET', query: { session_id: sessionId } });
  assert.equal(res.body.status, 'pending');
  assert.equal(res.headers['Cache-Control'], 'no-store');

  const key = await buy(sessionId, 'sub_14');
  res = await call(checkoutStatus, { method: 'GET', query: { session_id: sessionId } });
  assert.deepEqual(res.body, {
    status: 'complete', kind: 'subscription', licenseKey: key, plan: 'monthly', tokensIncluded: 200,
    trialEndsAt: null, tokenBalance: 200, soldThroughLink: false,
  });

  const marker = JSON.parse(store.get(`checkout:${sessionId}`));
  marker.at -= 25 * 60 * 60 * 1000;
  store.set(`checkout:${sessionId}`, JSON.stringify(marker));
  res = await call(checkoutStatus, { method: 'GET', query: { session_id: sessionId } });
  assert.deepEqual(res.body, { status: 'expired' });
});

test('checkout-status rejects malformed session ids', async () => {
  for (const id of [undefined, '', 'cs_test_x', 'license:FAUX', 'cs_live_abc/../../x']) {
    const res = await call(checkoutStatus, { method: 'GET', query: { session_id: id } });
    assert.equal(res.statusCode, 400, String(id));
  }
});

// ── Account page: key recovery and billing ────────────────────────────────────

test('account: same reply for known and unknown emails, and only owners get mail', async () => {
  const key = await buy('cs_test_account001', 'sub_15', 'price_monthly', 'owner@example.com');
  sentEmails.length = 0;

  const unknown = await call(billingPortal, { body: { email: 'stranger@example.com' } });
  const known = await call(billingPortal, { body: { email: ' Owner@Example.com ' } });
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual(unknown.body, known.body);
  assert.equal(known.body.url, undefined);

  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'owner@example.com');
  assert.ok(sentEmails[0].html.includes(key));
  const token = sentEmails[0].html.match(/account\?token=([a-f0-9]{48})/)[1];

  const portal = await call(billingPortal, { body: { token } });
  assert.equal(portal.statusCode, 200);
  assert.equal(portal.body.url, 'https://billing.stripe.com/p/session/test_123');
  assert.equal(stripeCalls.portal[0].customer, 'cus_123');
});

test('account: bad or expired tokens and bad emails are refused', async () => {
  let res = await call(billingPortal, { body: { token: 'f'.repeat(48) } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'LINK_EXPIRED');
  res = await call(billingPortal, { body: { token: 'not-a-token' } });
  assert.equal(res.statusCode, 400);
  res = await call(billingPortal, { body: { email: 'not-an-email' } });
  assert.equal(res.statusCode, 400);
  res = await call(billingPortal, { body: {} });
  assert.equal(res.statusCode, 400);
});

test('account: links are rate limited per email', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await call(billingPortal, { body: { email: 'spam@example.com' }, ip: `198.51.100.${i}` });
    assert.equal(res.statusCode, 200);
  }
  const res = await call(billingPortal, { body: { email: 'spam@example.com' }, ip: '198.51.100.99' });
  assert.equal(res.statusCode, 429);
});

// ── Free trial ────────────────────────────────────────────────────────────────

async function startTrial(sessionId, subId, priceId = 'price_monthly') {
  addSubscription(subId, priceId, { status: 'trialing' });
  const res = await sendEvent('checkout.session.completed', checkoutSession(sessionId, subId));
  assert.equal(res.statusCode, 200);
  return store.get(`subscription:${subId}`);
}

test('a trial starts with 50 tokens and its end date, not the full allowance', async () => {
  const key = await startTrial('cs_test_trial00001', 'sub_t1');
  const license = JSON.parse(store.get(`license:${key}`));
  assert.equal(license.tokenBalance, 50);
  assert.equal(license.tokensIncluded, 200);
  assert.equal(license.trialEndsAt, TRIAL_END * 1000);
  assert.equal(license.status, 'active');

  const status = await call(checkoutStatus, { method: 'GET', query: { session_id: 'cs_test_trial00001' } });
  assert.equal(status.body.trialEndsAt, TRIAL_END * 1000);
  assert.equal(status.body.tokenBalance, 50);

  const valid = await call(validateLicense, { body: { licenseKey: key } });
  assert.equal(valid.body.valid, true);
  assert.equal(valid.body.trialEndsAt, TRIAL_END * 1000);

  assert.match(sentEmails[0].html, /free trial/);
  assert.match(sentEmails[0].html, /50 scans/);
  assert.match(sentEmails[0].html, /October 27, 2026/);
});

test("the trial's $0 first invoice doesn't refill; the first real charge does", async () => {
  const key = await startTrial('cs_test_trial00002', 'sub_t2');
  const parent = { subscription_details: { subscription: 'sub_t2' } };

  await sendEvent('invoice.payment_succeeded', { id: 'in_t0', billing_reason: 'subscription_create', amount_paid: 0, parent });
  assert.equal(JSON.parse(store.get(`license:${key}`)).tokenBalance, 50);

  // Trial ends: the subscription turns active and the first charge refills.
  const sub = addSubscription('sub_t2', 'price_monthly', { status: 'active' });
  await sendEvent('customer.subscription.updated', sub);
  await sendEvent('invoice.payment_succeeded', { id: 'in_t1', billing_reason: 'subscription_cycle', amount_paid: 999, parent });
  const license = JSON.parse(store.get(`license:${key}`));
  assert.equal(license.tokenBalance, 200);
  assert.equal(license.trialEndsAt, null);
});

test('switching plans during a trial unlocks no extra tokens', async () => {
  const key = await startTrial('cs_test_trial00003', 'sub_t3');
  const upgraded = addSubscription('sub_t3', 'price_video_monthly', { status: 'trialing' });
  await sendEvent('customer.subscription.updated', upgraded);
  const license = JSON.parse(store.get(`license:${key}`));
  assert.equal(license.plan, 'video-monthly');
  assert.equal(license.tokenBalance, 50);
  assert.equal(license.trialEndsAt, TRIAL_END * 1000);
});

// ── Checkout parameters ───────────────────────────────────────────────────────

test('subscription checkout offers the 7-day trial', async () => {
  const res = await call(createCheckout, { body: { plan: 'monthly' } });
  assert.equal(res.statusCode, 200);
  assert.equal(stripeCalls.checkout[0].subscription_data.trial_period_days, 7);
  assert.equal(stripeCalls.checkout[0].managed_payments, undefined);
});

test('Managed Payments is requested only when STRIPE_MANAGED_PAYMENTS=true', async () => {
  process.env.STRIPE_MANAGED_PAYMENTS = 'true';
  try {
    const key = await buy('cs_test_mpForTopup', 'sub_mp1');
    let res = await call(createCheckout, { body: { plan: 'video-yearly', email: 'buyer@example.com' } });
    assert.equal(res.statusCode, 200);
    res = await call(createCheckout, { body: { mode: 'topup', packSize: 'large', licenseKey: key } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(stripeCalls.checkout.map(p => p.managed_payments), [{ enabled: true }, { enabled: true }]);

    const status = await call(checkoutStatus, { method: 'GET', query: { session_id: 'cs_test_mpForTopup' } });
    assert.equal(status.body.soldThroughLink, true);
  } finally {
    delete process.env.STRIPE_MANAGED_PAYMENTS;
  }
});

test('a top-up is charged to the same Stripe customer as the subscription', async () => {
  const key = await buy('cs_test_customer01', 'sub_c1');
  const res = await call(createCheckout, { body: { mode: 'topup', packSize: 'small', licenseKey: key, email: 'other@example.com' } });
  assert.equal(res.statusCode, 200);
  assert.equal(stripeCalls.checkout[0].customer, 'cus_123');
  assert.equal(stripeCalls.checkout[0].customer_email, undefined);
});

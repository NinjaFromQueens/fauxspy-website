// /api/create-checkout.js
// Creates a Stripe Checkout session for Pro subscriptions
// Subscriptions: monthly, yearly, video-monthly, video-yearly (promo codes allowed)
// Top-ups (mode: 'topup'): one-time token packs added to an existing license

const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');
const { resolveProLicense } = require('./_lib/license');

const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

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
  
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({
        error: 'STRIPE_NOT_CONFIGURED',
        message: 'Payment processing temporarily unavailable.'
      });
    }
    
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-05-28.basil' });
    const { plan, email, promoCode, mode, licenseKey, packSize } = req.body || {};

    const siteUrl = process.env.SITE_URL || 'https://fauxspy.com';

    // ── Top-up purchase ─────────────────────────────────────────────────────
    if (mode === 'topup') {
      const TOPUP_PRICES = {
        small:  process.env.STRIPE_PRICE_TOPUP_SMALL,   // 50 tokens  / $1.99
        medium: process.env.STRIPE_PRICE_TOPUP_MEDIUM,  // 200 tokens / $5.99
        large:  process.env.STRIPE_PRICE_TOPUP_LARGE,   // 500 tokens / $11.99
      };
      const TOPUP_TOKENS = { small: 50, medium: 200, large: 500 };

      if (!licenseKey || typeof licenseKey !== 'string') {
        return res.status(400).json({ error: 'MISSING_LICENSE_KEY', message: 'License key required for top-up.' });
      }
      if (typeof packSize !== 'string' || !Object.hasOwn(TOPUP_TOKENS, packSize)) {
        return res.status(400).json({ error: 'INVALID_PACK_SIZE', message: 'Pack size must be small, medium, or large.' });
      }
      const priceId = TOPUP_PRICES[packSize];
      if (!priceId) {
        console.error('❌ Missing top-up price env var for pack:', packSize);
        return res.status(500).json({ error: 'TOPUP_PRICE_NOT_CONFIGURED', message: 'This pack is temporarily unavailable. Try another size or email hello@fauxspy.com.' });
      }

      // Check the key before taking money: the webhook can only add tokens
      // to a license that exists and is still active.
      const { isPro, key, reason } = await resolveProLicense(kv, licenseKey);
      if (!isPro) {
        return reason === 'cancelled' || reason === 'inactive' || reason === 'expired'
          ? res.status(400).json({ error: 'LICENSE_INACTIVE', message: "This Pro plan is no longer active, so tokens can't be added to it. Renew at fauxspy.com/pro." })
          : res.status(400).json({ error: 'LICENSE_NOT_FOUND', message: "We couldn't find that license key. Check it for typos." });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${siteUrl}/buy-tokens?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/buy-tokens?cancelled=true`,
        ...(email ? { customer_email: email } : {}),
        metadata: {
          product: 'faux-spy-topup',
          licenseKey: key,
          packSize: String(TOPUP_TOKENS[packSize]),
        }
      });

      console.log('✅ Top-up checkout session created:', session.id, `(${packSize} / ${TOPUP_TOKENS[packSize]} tokens)`);
      return res.status(200).json({ url: session.url, sessionId: session.id });
    }

    // ── Subscription purchase ────────────────────────────────────────────────
    // Determine price ID
    const VALID_PLANS = ['monthly', 'yearly', 'video-monthly', 'video-yearly'];
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({
        error: 'INVALID_PLAN',
        message: 'Plan must be one of: monthly, yearly, video-monthly, video-yearly.'
      });
    }

    const PLAN_PRICE_IDS = {
      monthly:         process.env.STRIPE_PRICE_MONTHLY,
      yearly:          process.env.STRIPE_PRICE_YEARLY,
      'video-monthly': process.env.STRIPE_VIDEO_MONTHLY_PRICE_ID,
      'video-yearly':  process.env.STRIPE_VIDEO_YEARLY_PRICE_ID,
    };
    const priceId = PLAN_PRICE_IDS[plan];

    if (!priceId) {
      return res.status(500).json({
        error: 'PRICE_NOT_CONFIGURED',
        message: 'Payment processing temporarily unavailable.'
      });
    }
    
    // Build session parameters
    const sessionParams = {
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/pro?cancelled=true`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      // Pre-fill email if provided
      ...(email ? { customer_email: email } : {}),
      metadata: {
        product: 'faux-spy',
        plan: plan,
        ...(email ? { signup_email: email } : {})
      },
      subscription_data: {
        metadata: {
          product: 'faux-spy',
          plan: plan
        }
      }
    };
    
    // Apply promo code if provided
    let promoApplied = false;
    if (promoCode) {
      try {
        const promotionCodes = await stripe.promotionCodes.list({
          code: promoCode,
          active: true,
          limit: 1
        });

        if (promotionCodes.data.length > 0) {
          sessionParams.discounts = [{
            promotion_code: promotionCodes.data[0].id
          }];
          // Mutually exclusive with allow_promotion_codes
          delete sessionParams.allow_promotion_codes;
          promoApplied = true;
          console.log('✅ Promo code applied:', promoCode);
        } else {
          console.warn('⚠️ Promo code not found or inactive:', promoCode);
        }
      } catch (promoError) {
        console.warn('⚠️ Promo code lookup failed:', promoError.message);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log('✅ Checkout session created:', session.id);

    return res.status(200).json({
      url: session.url,
      sessionId: session.id,
      promoApplied,
    });
    
  } catch (error) {
    console.error('❌ Stripe checkout error:', error);
    return res.status(500).json({ 
      error: 'CHECKOUT_FAILED',
      message: 'Failed to create checkout session. Please try again.'
    });
  }
};

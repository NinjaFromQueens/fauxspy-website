// /api/create-checkout.js
// Creates a Stripe Checkout session for Pro subscriptions
// Supports monthly ($9.99) and yearly ($99) plans
// Includes 50% lifetime discount for waitlist signups via promo codes

const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      if (!packSize || !TOPUP_PRICES[packSize]) {
        return res.status(400).json({ error: 'INVALID_PACK_SIZE', message: 'Pack size must be small, medium, or large.' });
      }
      const priceId = TOPUP_PRICES[packSize];
      if (!priceId) {
        return res.status(500).json({ error: 'TOPUP_PRICE_NOT_CONFIGURED', message: 'Top-up prices not configured yet.' });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${siteUrl}/buy-tokens?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/buy-tokens?cancelled=true`,
        ...(email ? { customer_email: email } : {}),
        metadata: {
          product: 'faux-spy-topup',
          licenseKey: licenseKey.trim().toUpperCase(),
          packSize: String(TOPUP_TOKENS[packSize]),
        }
      });

      console.log('✅ Top-up checkout session created:', session.id, `(${packSize} / ${TOPUP_TOKENS[packSize]} tokens)`);
      return res.status(200).json({ url: session.url, sessionId: session.id });
    }

    // ── Subscription purchase ────────────────────────────────────────────────
    // Determine price ID
    if (plan !== 'monthly' && plan !== 'yearly') {
      return res.status(400).json({
        error: 'INVALID_PLAN',
        message: 'Plan must be "monthly" or "yearly".'
      });
    }

    const priceId = plan === 'yearly'
      ? process.env.STRIPE_PRICE_YEARLY
      : process.env.STRIPE_PRICE_MONTHLY;

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
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
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
    
    // Apply promo code if provided (e.g., WAITLIST50 for 50% off)
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
          // Remove allow_promotion_codes when applying one directly
          delete sessionParams.allow_promotion_codes;
        }
      } catch (promoError) {
        console.warn('⚠️ Promo code lookup failed:', promoError.message);
        // Continue without promo
      }
    }
    
    const session = await stripe.checkout.sessions.create(sessionParams);
    
    console.log('✅ Checkout session created:', session.id);
    
    return res.status(200).json({ 
      url: session.url,
      sessionId: session.id 
    });
    
  } catch (error) {
    console.error('❌ Stripe checkout error:', error);
    return res.status(500).json({ 
      error: 'CHECKOUT_FAILED',
      message: 'Failed to create checkout session. Please try again.'
    });
  }
};

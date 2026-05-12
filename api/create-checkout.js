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
    const { plan, email, promoCode } = req.body || {};
    
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
    
    const siteUrl = process.env.SITE_URL || 'https://fauxspy.com';
    
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

// /api/create-checkout.js
// Creates a Stripe Checkout session for subscription purchases

const Stripe = require('stripe');

module.exports = async (req, res) => {
  // Enable CORS
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
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { plan } = req.body || {};
    
    // Determine price ID based on plan
    const priceId = plan === 'yearly' 
      ? process.env.STRIPE_PRICE_YEARLY 
      : process.env.STRIPE_PRICE_MONTHLY;
    
    if (!priceId) {
      return res.status(400).json({ 
        error: 'Invalid plan. Must be "monthly" or "yearly".' 
      });
    }
    
    const siteUrl = process.env.SITE_URL || 'https://fauxspy.com';
    
    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?cancelled=true`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: {
        product: 'faux-spy',
        plan: plan
      }
    });
    
    return res.status(200).json({ url: session.url });
    
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({ 
      error: 'Failed to create checkout session',
      message: error.message 
    });
  }
};

// /api/billing-portal.js
// Creates a Stripe Customer Portal session for subscription management
// Users enter email → look up customer → redirect to Stripe portal

const Stripe = require('stripe');
const { kv } = require('@vercel/kv');

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
        message: 'Subscription management temporarily unavailable.'
      });
    }
    
    const { email } = req.body || {};
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ 
        error: 'INVALID_EMAIL',
        message: 'Valid email required' 
      });
    }
    
    const cleanEmail = email.trim().toLowerCase();
    
    // Look up license by email
    const licenseKey = await kv.get(`email:${cleanEmail}`);
    
    if (!licenseKey) {
      return res.status(404).json({
        error: 'NO_SUBSCRIPTION',
        message: 'No subscription found for this email. Make sure you used the correct email at checkout.'
      });
    }
    
    const license = await kv.get(`license:${licenseKey}`);
    
    if (!license || !license.customerId) {
      return res.status(404).json({
        error: 'NO_CUSTOMER',
        message: 'No subscription found. Contact support if this seems wrong.'
      });
    }
    
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const siteUrl = process.env.SITE_URL || 'https://fauxspy.com';
    
    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: license.customerId,
      return_url: `${siteUrl}/account`
    });
    
    return res.status(200).json({ 
      url: session.url 
    });
    
  } catch (error) {
    console.error('Billing portal error:', error);
    return res.status(500).json({ 
      error: 'PORTAL_FAILED',
      message: error.message || 'Could not create portal session'
    });
  }
};

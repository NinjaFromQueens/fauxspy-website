// /api/validate-license.js
// Validates license keys submitted by the extension
// Returns Pro status, plan, expiration

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
    const { licenseKey } = req.body || {};
    
    if (!licenseKey || typeof licenseKey !== 'string') {
      return res.status(400).json({ 
        valid: false,
        error: 'License key required' 
      });
    }
    
    const cleanKey = licenseKey.trim().toUpperCase();
    
    // Validate format
    if (!cleanKey.match(/^FAUX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)) {
      return res.status(400).json({
        valid: false,
        error: 'Invalid license key format',
        message: 'License keys look like: FAUX-XXXX-XXXX-XXXX-XXXX'
      });
    }
    
    // Look up license
    const license = await kv.get(`license:${cleanKey}`);
    
    if (!license) {
      return res.status(404).json({
        valid: false,
        error: 'License not found',
        message: 'This license key does not exist. Check for typos.'
      });
    }
    
    // Check status
    if (license.status === 'cancelled') {
      return res.status(200).json({
        valid: false,
        error: 'Subscription cancelled',
        message: 'Your subscription has been cancelled. Renew at fauxspy.com/pro'
      });
    }
    
    if (license.status === 'inactive') {
      return res.status(200).json({
        valid: false,
        error: 'License inactive',
        message: 'There may be a payment issue. Check your email or visit fauxspy.com/account'
      });
    }
    
    // Check expiration (with 3-day grace period)
    const gracePeriodMs = 3 * 24 * 60 * 60 * 1000;
    if (license.expiresAt && Date.now() > license.expiresAt + gracePeriodMs) {
      return res.status(200).json({
        valid: false,
        error: 'License expired',
        message: 'Your subscription has expired. Renew at fauxspy.com/pro'
      });
    }
    
    // License is valid!
    return res.status(200).json({
      valid: true,
      isPro: true,
      plan: license.plan,
      email: license.email,
      expiresAt: license.expiresAt,
      // Don't send sensitive Stripe IDs back to extension
      features: {
        unlimitedScans: true,
        deepDive: true,
        caseFiles: true,
        priorityDetection: true
      }
    });
    
  } catch (error) {
    console.error('License validation error:', error);
    return res.status(500).json({ 
      valid: false,
      error: 'Validation failed',
      message: 'Could not validate license. Try again in a moment.'
    });
  }
};

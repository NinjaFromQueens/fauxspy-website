// /api/waitlist.js
// Simple waitlist endpoint - logs emails to Vercel logs
// Upgrade to Supabase/database when ready

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
    const { email, source } = req.body || {};
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    
    // Log to Vercel logs (you can see in Vercel dashboard → Logs)
    // To collect properly later, integrate with Mailchimp, ConvertKit, or Supabase
    console.log('🎉 NEW WAITLIST SIGNUP:', {
      email: email,
      source: source || 'unknown',
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || 'unknown'
    });
    
    // TODO: Add to email list service
    // Option 1: Mailchimp
    // const response = await fetch(`https://us1.api.mailchimp.com/3.0/lists/${LIST_ID}/members`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${process.env.MAILCHIMP_API_KEY}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     email_address: email,
    //     status: 'subscribed',
    //     tags: [source]
    //   })
    // });
    
    // Option 2: ConvertKit
    // await fetch(`https://api.convertkit.com/v3/forms/${FORM_ID}/subscribe`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     api_key: process.env.CONVERTKIT_API_KEY,
    //     email: email
    //   })
    // });
    
    // Option 3: Supabase
    // const { createClient } = require('@supabase/supabase-js');
    // const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // await supabase.from('waitlist').insert([{ email, source, created_at: new Date() }]);
    
    return res.status(200).json({ 
      success: true,
      message: "You're on the list!"
    });
    
  } catch (error) {
    console.error('Waitlist error:', error);
    return res.status(500).json({ error: 'Failed to save signup' });
  }
};

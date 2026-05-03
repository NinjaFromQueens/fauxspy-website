// /api/validate-license.js
// Validates a license key from the Chrome extension

module.exports = async (req, res) => {
  // Enable CORS - extension will call this
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
    
    if (!licenseKey) {
      return res.status(400).json({ 
        valid: false, 
        error: 'License key required' 
      });
    }
    
    // Validate format: FAUX-XXXX-XXXX-XXXX-XXXX
    const formatRegex = /^FAUX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    if (!formatRegex.test(licenseKey)) {
      return res.status(200).json({ 
        valid: false, 
        error: 'Invalid license key format' 
      });
    }
    
    // TODO: Look up license in database
    const license = await lookupLicense(licenseKey);
    
    if (!license) {
      return res.status(200).json({ 
        valid: false, 
        error: 'License key not found' 
      });
    }
    
    if (license.status !== 'active') {
      return res.status(200).json({ 
        valid: false, 
        error: `License is ${license.status}` 
      });
    }
    
    return res.status(200).json({
      valid: true,
      plan: license.plan,
      email: license.email
    });
    
  } catch (error) {
    console.error('License validation error:', error);
    return res.status(500).json({ 
      valid: false,
      error: 'Validation failed' 
    });
  }
};

async function lookupLicense(licenseKey) {
  // TODO: Replace with actual database query
  // const { createClient } = require('@supabase/supabase-js');
  // const supabase = createClient(
  //   process.env.SUPABASE_URL,
  //   process.env.SUPABASE_SERVICE_KEY
  // );
  // 
  // const { data, error } = await supabase
  //   .from('licenses')
  //   .select('*')
  //   .eq('license_key', licenseKey)
  //   .single();
  // 
  // return data;
  
  // For now, return null (no DB connected yet)
  return null;
}

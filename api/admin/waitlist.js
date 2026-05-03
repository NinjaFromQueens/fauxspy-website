// /api/admin/waitlist.js
// View/export waitlist signups
// Protected by ADMIN_TOKEN environment variable

const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  // Require admin token
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get total count
    const count = await kv.get('waitlist:count') || 0;
    
    // Get all email addresses
    const emails = await kv.smembers('waitlist:all') || [];
    
    // Get full data for each email (parallel for speed)
    const fullData = await Promise.all(
      emails.map(async (email) => {
        try {
          return await kv.get(`waitlist:${email}`);
        } catch (e) {
          return { email, error: 'Failed to load' };
        }
      })
    );
    
    // Sort by timestamp (newest first)
    fullData.sort((a, b) => {
      if (!a?.timestamp) return 1;
      if (!b?.timestamp) return -1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
    
    // Support CSV export via ?format=csv
    if (req.query.format === 'csv') {
      const csv = [
        'email,source,timestamp,ip',
        ...fullData.map(d => 
          `${d.email},${d.source || ''},${d.timestamp || ''},${d.ip || ''}`
        )
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="waitlist.csv"');
      return res.status(200).send(csv);
    }
    
    return res.status(200).json({
      count,
      total: fullData.length,
      signups: fullData
    });
    
  } catch (error) {
    console.error('Admin waitlist error:', error);
    return res.status(500).json({ 
      error: 'Failed to load waitlist',
      message: error.message
    });
  }
};

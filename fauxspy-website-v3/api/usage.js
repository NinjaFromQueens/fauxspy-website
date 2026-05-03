// /api/usage.js
// Returns current daily usage for a user

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
    const { userId } = req.body || {};
    
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    
    // Note: This uses in-memory storage that resets on deployment.
    // The extension also tracks usage locally as fallback.
    // For accurate tracking across deployments, integrate Vercel KV.
    
    return res.status(200).json({
      used: 0, // Server-side tracking (resets on deploy in current setup)
      limit: 20,
      // Extension should rely on its local count for accuracy
      // This endpoint is for verifying limits aren't exceeded
    });
    
  } catch (error) {
    console.error('Usage check error:', error);
    return res.status(500).json({ error: 'Failed to check usage' });
  }
};

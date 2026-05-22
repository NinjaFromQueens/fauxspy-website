module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Require the IndexNow key as a secret to prevent public abuse
  const secret = req.query.secret || req.headers['x-indexnow-secret'];
  if (process.env.INDEXNOW_KEY && secret !== process.env.INDEXNOW_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const key = process.env.INDEXNOW_KEY || 'a3f8b2e1d94c6071a5b8d23e1f406789';
  const host = 'fauxspy.com';

  const urls = [
    'https://fauxspy.com/',
    'https://fauxspy.com/pro',
    'https://fauxspy.com/faq',
    'https://fauxspy.com/deepfake-detector',
    'https://fauxspy.com/catfish-detector',
    'https://fauxspy.com/dating-apps',
    'https://fauxspy.com/instagram',
    'https://fauxspy.com/linkedin',
    'https://fauxspy.com/pinterest',
    'https://fauxspy.com/tiktok',
    'https://fauxspy.com/ai-art-detector',
    'https://fauxspy.com/buy-tokens',
    'https://fauxspy.com/contact',
    'https://fauxspy.com/privacy',
    'https://fauxspy.com/terms',
    'https://fauxspy.com/refunds',
    'https://fauxspy.com/account',
    'https://fauxspy.com/tinder',
    'https://fauxspy.com/bumble',
    'https://fauxspy.com/hinge',
    'https://fauxspy.com/how-to-spot-ai-generated-images',
    'https://fauxspy.com/romance-scam-warning-signs',
  ];

  try {
    const response = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `https://${host}/${key}.txt`,
        urlList: urls,
      }),
    });

    return res.status(200).json({
      submitted: urls.length,
      indexnow_status: response.status,
      indexnow_ok: response.ok,
    });
  } catch (error) {
    console.error('IndexNow submission error:', error);
    return res.status(500).json({ error: 'Failed to submit to IndexNow', details: error.message });
  }
};

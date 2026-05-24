const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const resource = req.query.resource;

  if (resource === 'contact') {
    try {
      const count = await kv.get('contact:count') || 0;
      const unread = await kv.get('contact:unread') || 0;
      const ids = await kv.smembers('contact:all') || [];

      const submissions = await Promise.all(
        ids.map(async (id) => {
          try { return await kv.get(`contact:${id}`); } catch { return null; }
        })
      );

      const valid = submissions.filter(s => s !== null);
      valid.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      if (req.query.format === 'csv') {
        const csv = [
          'id,timestamp,name,email,topic,message',
          ...valid.map(s =>
            `${s.id},${s.timestamp},${escapeCSV(s.name)},${s.email},${s.topic},${escapeCSV(s.message)}`
          )
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
        return res.status(200).send(csv);
      }

      return res.status(200).json({ count, unread, total: valid.length, submissions: valid });
    } catch (error) {
      console.error('Admin contact error:', error);
      return res.status(500).json({ error: 'Failed to load submissions' });
    }
  }

  if (resource === 'waitlist') {
    try {
      const count = await kv.get('waitlist:count') || 0;
      const emails = await kv.smembers('waitlist:all') || [];

      const fullData = await Promise.all(
        emails.map(async (email) => {
          try { return await kv.get(`waitlist:${email}`); } catch { return { email, error: 'Failed to load' }; }
        })
      );

      fullData.sort((a, b) => {
        if (!a?.timestamp) return 1;
        if (!b?.timestamp) return -1;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });

      if (req.query.format === 'csv') {
        const csv = [
          'email,source,timestamp,ip',
          ...fullData.map(d => `${d.email},${d.source || ''},${d.timestamp || ''},${d.ip || ''}`)
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="waitlist.csv"');
        return res.status(200).send(csv);
      }

      return res.status(200).json({ count, total: fullData.length, signups: fullData });
    } catch (error) {
      console.error('Admin waitlist error:', error);
      return res.status(500).json({ error: 'Failed to load waitlist', message: error.message });
    }
  }

  return res.status(400).json({ error: 'Missing resource parameter. Use ?resource=contact or ?resource=waitlist' });
};

function escapeCSV(str) {
  if (typeof str !== 'string') return '';
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

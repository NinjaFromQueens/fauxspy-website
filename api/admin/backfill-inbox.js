// /api/admin/backfill-inbox.js
// One-time import of past received emails from Resend into the admin inbox.
// Resend stores all received emails even without a webhook configured.
// This endpoint fetches that history and stores any missing entries in Redis.

const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

module.exports = async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  }

  try {
    // Fetch the list of received emails from Resend
    const listResp = await fetch('https://api.resend.com/emails/receiving?limit=100', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!listResp.ok) {
      const errText = await listResp.text();
      return res.status(502).json({ error: 'Resend API error', message: errText });
    }

    const listData = await listResp.json();
    const emails = listData.data || [];

    let imported = 0;
    let skipped = 0;

    for (const email of emails) {
      const emailId = email.email_id || email.id;
      if (!emailId) { skipped++; continue; }

      // Skip if already imported
      const dedupKey = `inbox:dedup:${emailId}`;
      const alreadyDone = await kv.get(dedupKey);
      if (alreadyDone) { skipped++; continue; }

      // Fetch full email content (body/headers not included in list response)
      let fullEmail = {};
      try {
        const detailResp = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (detailResp.ok) fullEmail = await detailResp.json();
        else console.warn('backfill: detail fetch failed for', emailId, detailResp.status);
      } catch (e) {
        console.warn('backfill: detail fetch error for', emailId, e.message);
      }

      const fromRaw = email.from || fullEmail.from || '';
      const fromMatch = fromRaw.match(/^(.+?)\s*<([^>]+)>$/);
      const fromName = fromMatch ? fromMatch[1].trim() : '';
      const fromEmail = fromMatch ? fromMatch[2].trim() : fromRaw.trim();

      if (!fromEmail) { skipped++; continue; }

      const subject = email.subject || fullEmail.subject || '(no subject)';
      const text = fullEmail.text || '';
      const html = fullEmail.html || '';
      const hdrs = Array.isArray(fullEmail.headers) ? fullEmail.headers : [];
      const messageId = email.message_id || hdrs.find(h => h.name === 'Message-ID')?.value || '';
      const inReplyTo = hdrs.find(h => h.name === 'In-Reply-To')?.value || '';
      const timestamp = email.created_at || new Date().toISOString();

      const id = `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const record = { id, from: fromEmail, fromName, subject, text, html, messageId, inReplyTo, timestamp, status: 'unread' };

      await kv.set(`inbox:${id}`, record);
      await kv.sadd('inbox:all', id);
      await kv.incr('inbox:unread');
      await kv.set(dedupKey, '1', { ex: 60 * 60 * 24 * 30 }); // 30-day TTL

      console.log('backfill: imported', emailId, 'from:', fromEmail);
      imported++;
    }

    return res.status(200).json({ ok: true, imported, skipped, total: emails.length });
  } catch (err) {
    console.error('Backfill error:', err);
    return res.status(500).json({ error: 'Backfill failed', message: err.message });
  }
};

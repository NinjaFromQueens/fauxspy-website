const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});
const { Resend } = require('resend');

const crypto = require('crypto');

module.exports = async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  const secret = process.env.ADMIN_TOKEN;
  const valid = adminToken && secret &&
    adminToken.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(secret));
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── POST: mark-read, reply ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, id, to, subject, body, messageId } = req.body || {};

    if (action === 'mark-read') {
      try {
        const record = await kv.get(`inbox:${id}`);
        if (record && record.status === 'unread') {
          record.status = 'read';
          await kv.set(`inbox:${id}`, record);
          const current = await kv.get('inbox:unread') || 0;
          if (current > 0) await kv.decr('inbox:unread');
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to mark read', message: err.message });
      }
    }

    if (action === 'reply') {
      if (!to || !subject || !body) {
        return res.status(400).json({ error: 'to, subject, and body are required' });
      }
      if (!process.env.RESEND_API_KEY) {
        return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
      }
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const from = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';

        const emailPayload = {
          from,
          to,
          subject,
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1f2e;max-width:600px;margin:0 auto;padding:20px;">
${body.replace(/\n/g, '<br>')}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
<p style="color:#94a3b8;font-size:12px;">Faux Spy &middot; <a href="https://www.fauxspy.com" style="color:#d97706;">fauxspy.com</a></p>
</div>`,
          text: body,
        };

        if (messageId) {
          emailPayload.headers = {
            'In-Reply-To': messageId,
            'References': messageId,
          };
        }

        await resend.emails.send(emailPayload);

        // Update record status
        if (id) {
          const record = await kv.get(`inbox:${id}`);
          if (record) {
            const wasUnread = record.status === 'unread';
            record.status = 'replied';
            record.repliedAt = new Date().toISOString();
            await kv.set(`inbox:${id}`, record);
            if (wasUnread) {
              const current = await kv.get('inbox:unread') || 0;
              if (current > 0) await kv.decr('inbox:unread');
            }
          }
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('Reply send error:', err);
        return res.status(500).json({ error: 'Failed to send reply', message: err.message });
      }
    }

    if (action === 'inbox-debug') {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
      const raw = await fetch('https://api.resend.com/emails/receiving?limit=100', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const body = await raw.json();
      return res.status(raw.status).json({ resendStatus: raw.status, body });
    }

    if (action === 'backfill') {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
      try {
        const listResp = await fetch('https://api.resend.com/emails/receiving?limit=100', {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!listResp.ok) {
          const errText = await listResp.text();
          return res.status(502).json({ error: 'Resend API error', message: errText });
        }
        const { data: emails = [] } = await listResp.json();
        let imported = 0, skipped = 0;
        for (const email of emails) {
          const emailId = email.id;
          if (!emailId) { skipped++; continue; }
          // Use Resend email.id as the record key — stable, no random ID collisions
          if (await kv.get(`inbox:${emailId}`)) { skipped++; continue; }
          // Clear any orphaned dedup key left by a previous timed-out backfill run
          await kv.del(`inbox:dedup:${emailId}`);
          const fromRaw = email.from || '';
          const m = fromRaw.match(/^(.+?)\s*<([^>]+)>$/);
          const fromName = m ? m[1].trim() : '';
          const fromEmail = m ? m[2].trim() : fromRaw.trim();
          if (!fromEmail) { skipped++; continue; }
          // Store list metadata only — no per-email detail fetch avoids Vercel timeout
          const record = {
            id: emailId,
            from: fromEmail, fromName,
            subject: email.subject || '(no subject)',
            text: '', html: '',
            messageId: email.message_id || '',
            inReplyTo: '',
            timestamp: email.created_at,
            status: 'unread'
          };
          await kv.set(`inbox:${emailId}`, record);
          await kv.sadd('inbox:all', emailId);
          await kv.incr('inbox:unread');
          imported++;
        }
        return res.status(200).json({ ok: true, imported, skipped, total: emails.length });
      } catch (err) {
        return res.status(500).json({ error: 'Backfill failed', message: err.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const resource = req.query.resource;

  // ── GET inbox ───────────────────────────────────────────────────────────────
  if (resource === 'inbox') {
    try {
      const unread = await kv.get('inbox:unread') || 0;
      const ids = await kv.smembers('inbox:all') || [];

      const messages = await Promise.all(
        ids.map(async (msgId) => {
          try { return await kv.get(`inbox:${msgId}`); } catch { return null; }
        })
      );

      const valid = messages.filter(m => m !== null);
      valid.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return res.status(200).json({ unread, total: valid.length, messages: valid });
    } catch (err) {
      console.error('Admin inbox error:', err);
      return res.status(500).json({ error: 'Failed to load inbox', message: err.message });
    }
  }

  // ── GET contact ─────────────────────────────────────────────────────────────
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

  // ── GET waitlist ─────────────────────────────────────────────────────────────
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

  return res.status(400).json({ error: 'Missing or unknown resource parameter' });
};

function escapeCSV(str) {
  if (typeof str !== 'string') return '';
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

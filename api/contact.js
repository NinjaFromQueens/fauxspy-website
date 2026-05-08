// /api/contact.js
// Handles contact form submissions
// Saves to Vercel KV for record + emails you via Resend

const { kv } = require('@vercel/kv');
const { Resend } = require('resend');

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
    const { name, email, topic, message } = req.body || {};
    
    // Validate required fields
    if (!name || !email || !topic || !message) {
      return res.status(400).json({ 
        error: 'MISSING_FIELDS',
        message: 'All fields are required' 
      });
    }
    
    // Validate email
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ 
        error: 'INVALID_EMAIL',
        message: 'Invalid email format' 
      });
    }
    
    // Validate length (prevent abuse)
    if (message.length > 5000) {
      return res.status(400).json({ 
        error: 'MESSAGE_TOO_LONG',
        message: 'Message too long (max 5000 chars)' 
      });
    }
    
    // Build submission object
    const submission = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      name: name.trim().substring(0, 200),
      email: cleanEmail,
      topic: topic,
      message: message.trim().substring(0, 5000),
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
      userAgent: req.headers['user-agent']?.substring(0, 200) || 'unknown',
      status: 'unread'
    };
    
    // Save to Vercel KV
    let savedToKV = false;
    try {
      await kv.set(`contact:${submission.id}`, submission);
      await kv.sadd('contact:all', submission.id);
      await kv.incr('contact:count');
      // Also track unread count
      await kv.incr('contact:unread');
      savedToKV = true;
      console.log('✅ Contact saved to KV:', submission.id);
    } catch (kvError) {
      console.warn('⚠️ KV save failed:', kvError.message);
    }
    
    // Send email notification to admin via Resend
    let emailSent = false;
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const adminEmail = process.env.ADMIN_EMAIL || 'hello@fauxspy.com';
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';
        
        // Topic emoji map
        const topicEmoji = {
          bug: '🐛',
          feature: '💡',
          support: '❓',
          billing: '💳',
          partnership: '🤝',
          press: '📰',
          other: '💬'
        };
        
        await resend.emails.send({
          from: fromEmail,
          to: adminEmail,
          replyTo: cleanEmail,
          subject: `${topicEmoji[topic] || '💬'} [Faux Spy Contact] ${topic.toUpperCase()}: ${name}`,
          html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%); padding: 24px; border-radius: 12px 12px 0 0; color: #1a1f2e;">
    <h2 style="margin: 0;">${topicEmoji[topic] || '💬'} New Contact Form Submission</h2>
  </div>
  <div style="padding: 24px; background: #f8fafc; border-radius: 0 0 12px 12px;">
    <table style="width: 100%; border-collapse: collapse;">
      <tr>
        <td style="padding: 8px 0; font-weight: 600; width: 100px;">From:</td>
        <td style="padding: 8px 0;">${escapeHtml(name)} &lt;${escapeHtml(cleanEmail)}&gt;</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; font-weight: 600;">Topic:</td>
        <td style="padding: 8px 0;">${escapeHtml(topic)}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; font-weight: 600;">Time:</td>
        <td style="padding: 8px 0;">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <h3 style="margin-top: 20px; color: #1a1f2e;">Message:</h3>
    <div style="padding: 16px; background: white; border-left: 4px solid #fbbf24; border-radius: 4px; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(message)}</div>
    <p style="margin-top: 20px; color: #94a3b8; font-size: 12px;">
      Reply to this email to respond to ${escapeHtml(name)} directly.<br>
      Submission ID: ${submission.id}
    </p>
  </div>
</body>
</html>
          `.trim()
        });
        
        emailSent = true;
        console.log('✅ Notification email sent');
      } catch (emailError) {
        console.warn('⚠️ Email notification failed:', emailError.message);
      }
    }
    
    // Always log
    console.log('📨 NEW CONTACT FORM:', JSON.stringify({
      id: submission.id,
      name: submission.name,
      email: submission.email,
      topic: submission.topic
    }));
    
    return res.status(200).json({
      success: true,
      message: 'Message received! We\'ll respond within 24 hours.',
      id: submission.id,
      stored: savedToKV,
      notified: emailSent
    });
    
  } catch (error) {
    console.error('Contact form error:', error);
    return res.status(500).json({ 
      error: 'SUBMISSION_FAILED',
      message: 'Could not send message. Please email hello@fauxspy.com directly.'
    });
  }
};

// HTML escape utility
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// /api/waitlist.js
// Production-grade waitlist endpoint
// Stores emails in Vercel KV + adds to Resend Audience
// Sends confirmation email automatically

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
    const { email, source } = req.body || {};
    
    // Validate email format
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }
    
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // ========================================================================
    // STEP 1: Check if already on waitlist
    // ========================================================================
    let existing = null;
    try {
      existing = await kv.get(`waitlist:${cleanEmail}`);
    } catch (kvError) {
      console.warn('⚠️ KV not available, falling back to logs:', kvError.message);
    }
    
    if (existing) {
      console.log('ℹ️ Already on waitlist:', cleanEmail);
      return res.status(200).json({
        success: true,
        message: "You're already on the list!",
        alreadySubscribed: true
      });
    }
    
    // ========================================================================
    // STEP 2: Save to Vercel KV
    // ========================================================================
    const signupData = {
      email: cleanEmail,
      source: source || 'unknown',
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown'
    };
    
    let kvSuccess = false;
    try {
      // Store individual email
      await kv.set(`waitlist:${cleanEmail}`, signupData);
      
      // Add to a list of all emails (for easy export)
      await kv.sadd('waitlist:all', cleanEmail);
      
      // Increment counter
      await kv.incr('waitlist:count');
      
      kvSuccess = true;
      console.log('✅ Saved to KV:', cleanEmail);
    } catch (kvError) {
      console.error('❌ KV storage failed:', kvError.message);
      // Continue anyway - we'll log it for backup
    }
    
    // ========================================================================
    // STEP 3: Add to Resend Audience (for marketing)
    // ========================================================================
    let resendSuccess = false;
    if (process.env.RESEND_API_KEY && process.env.RESEND_AUDIENCE_ID) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        
        await resend.contacts.create({
          email: cleanEmail,
          audienceId: process.env.RESEND_AUDIENCE_ID,
          unsubscribed: false
        });
        
        resendSuccess = true;
        console.log('✅ Added to Resend audience:', cleanEmail);
      } catch (resendError) {
        // Don't fail the whole request - email is still saved in KV
        console.warn('⚠️ Resend audience add failed:', resendError.message);
      }
    } else {
      console.log('ℹ️ Resend not configured (RESEND_API_KEY or RESEND_AUDIENCE_ID missing)');
    }
    
    // ========================================================================
    // STEP 4: Send confirmation email
    // ========================================================================
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';
        
        await resend.emails.send({
          from: fromEmail,
          to: cleanEmail,
          subject: '🕵️ You\'re on the Faux Spy Pro waitlist!',
          html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.6; color: #1a1f2e; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 32px 0; }
    .logo { font-family: Georgia, serif; font-style: italic; font-size: 32px; font-weight: 800; background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .badge { display: inline-block; padding: 6px 14px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; border-radius: 100px; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin: 16px 0; }
    .content { padding: 24px; background: #f8fafc; border-radius: 12px; margin: 16px 0; }
    h1 { font-family: Georgia, serif; font-style: italic; font-size: 28px; }
    .perk { padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
    .perk:last-child { border-bottom: none; }
    .footer { text-align: center; color: #94a3b8; font-size: 13px; padding: 24px 0; }
    a { color: #d97706; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🕵️ Faux Spy</div>
    <div class="badge">WAITLIST CONFIRMED</div>
  </div>
  
  <h1>You're on the list!</h1>
  
  <p>Hey there, future Secret Agent 🕵️</p>
  
  <p>Thanks for joining the Faux Spy Pro waitlist. You're now locked in for early access + your <strong>50% lifetime discount</strong> when Pro launches.</p>
  
  <div class="content">
    <h3 style="margin-top: 0;">What you've reserved:</h3>
    <div class="perk">✨ <strong>50% off forever</strong> — $4.99/mo instead of $9.99/mo</div>
    <div class="perk">🚀 <strong>Early access</strong> — Try Pro before public launch</div>
    <div class="perk">🎁 <strong>Founding Member badge</strong> — Permanent profile flair</div>
    <div class="perk">🎯 <strong>Deep Dive mode</strong> — Investigate every image on a page</div>
  </div>
  
  <p><strong>What happens next?</strong></p>
  <p>You'll get one more email — when Pro launches. We'll send your discount code and early access link. That's it. No spam, no nonsense.</p>
  
  <p>While you wait, you can install the free version:</p>
  <p><a href="https://chromewebstore.google.com" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #fbbf24, #d97706); color: #1a1f2e; text-decoration: none; border-radius: 8px; font-weight: 700;">🕵️ Install Faux Spy Free</a></p>
  
  <p>Free tier includes:<br>
  • 20 investigations per day<br>
  • Hover, Ctrl+Click, and Right-click detection<br>
  • Works on Instagram, Pinterest, X, and more<br>
  • All detective badges</p>
  
  <div class="footer">
    <p>Spy on the fakes 🕵️<br>
    <a href="https://fauxspy.com">fauxspy.com</a></p>
    <p style="font-size: 11px;">You received this because you signed up at fauxspy.com/pro<br>
    Don't want these emails? Just reply with "unsubscribe"</p>
  </div>
</body>
</html>
          `.trim()
        });
        
        console.log('✅ Confirmation email sent:', cleanEmail);
      } catch (emailError) {
        console.warn('⚠️ Confirmation email failed:', emailError.message);
        // Non-fatal - signup still recorded
      }
    }
    
    // ========================================================================
    // STEP 5: Always log for backup (even if KV worked)
    // ========================================================================
    console.log('🎉 NEW WAITLIST SIGNUP:', JSON.stringify(signupData));
    
    return res.status(200).json({
      success: true,
      message: "You're on the list! Check your email.",
      stored: kvSuccess,
      emailListed: resendSuccess
    });
    
  } catch (error) {
    console.error('❌ Waitlist error:', error);
    return res.status(500).json({ 
      error: 'Failed to save signup',
      message: error.message 
    });
  }
};

// /api/webhook.js
// Handles Stripe webhook events for subscription lifecycle

const Stripe = require('stripe');

// Disable Vercel's default body parser (Stripe needs raw body)
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

// Helper to read raw body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Generate license key in format: FAUX-XXXX-XXXX-XXXX-XXXX
function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () => Array.from({ length: 4 }, () => 
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  
  return `FAUX-${segment()}-${segment()}-${segment()}-${segment()}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
  
  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerEmail = session.customer_details?.email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        
        // Generate license key
        const licenseKey = generateLicenseKey();
        
        console.log('✅ New subscription:', {
          email: customerEmail,
          customerId,
          subscriptionId,
          licenseKey
        });
        
        // TODO: Save to your database (Supabase example below)
        await saveLicenseToDatabase({
          email: customerEmail,
          customerId,
          subscriptionId,
          licenseKey,
          plan: session.metadata?.plan || 'monthly',
          status: 'active'
        });
        
        // TODO: Email license key to user
        await sendLicenseEmail(customerEmail, licenseKey);
        
        break;
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        console.log('Subscription updated:', subscription.id, subscription.status);
        // TODO: Update license status in DB
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        console.log('Subscription cancelled:', subscription.id);
        // TODO: Mark license as inactive in DB
        break;
      }
      
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('Payment failed:', invoice.id);
        // TODO: Email user about failed payment
        break;
      }
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
    
    return res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// Database integration - replace with your actual database
async function saveLicenseToDatabase(data) {
  // OPTION 1: Supabase (recommended)
  // const { createClient } = require('@supabase/supabase-js');
  // const supabase = createClient(
  //   process.env.SUPABASE_URL,
  //   process.env.SUPABASE_SERVICE_KEY
  // );
  // 
  // const { data: insertedData, error } = await supabase
  //   .from('licenses')
  //   .insert([{
  //     email: data.email,
  //     license_key: data.licenseKey,
  //     stripe_customer_id: data.customerId,
  //     stripe_subscription_id: data.subscriptionId,
  //     plan: data.plan,
  //     status: data.status,
  //     created_at: new Date()
  //   }]);
  
  // OPTION 2: Just log it for now (until DB is set up)
  console.log('💾 License to save:', data);
  
  return data;
}

// Email integration - replace with your email service
async function sendLicenseEmail(email, licenseKey) {
  // OPTION 1: Resend (recommended)
  // const { Resend } = require('resend');
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // 
  // await resend.emails.send({
  //   from: 'Faux Spy <hello@fauxspy.com>',
  //   to: email,
  //   subject: '🕵️ Welcome to Faux Spy! Your license key inside',
  //   html: `
  //     <h1>Welcome, Secret Agent! 🕵️</h1>
  //     <p>Your license key:</p>
  //     <code style="font-size:18px;background:#f0f0f0;padding:8px 16px;border-radius:8px">${licenseKey}</code>
  //     <p>Open the Faux Spy extension and paste your license key in Settings.</p>
  //   `
  // });
  
  console.log(`📧 Would send license to ${email}: ${licenseKey}`);
}

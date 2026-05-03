# 🚀 Faux Spy Deployment Guide

Complete walkthrough: Landing Page → Vercel → Stripe → Live!

**Estimated time:** 60–90 minutes  
**Cost:** ~$10/year (just the domain)

---

## 📋 What You're Deploying

```
Chrome Extension        →  Chrome Web Store
fauxspy.com (website)  →  Vercel
Stripe payments        →  Vercel API routes
```

The extension goes to **Chrome Web Store**. The landing page and payment backend go to **Vercel**.

---

## Part 1: Set Up Stripe (15 min)

### 1.1 Create Stripe Account

1. Go to [stripe.com](https://stripe.com) and sign up
2. Verify your email
3. Complete business profile (you can skip this for testing)

### 1.2 Create Products

1. Dashboard → **Products** → **+ Add product**
2. Create **"Faux Spy Secret Agent (Monthly)"**:
   - Name: `Faux Spy - Secret Agent`
   - Pricing: `Recurring`, `$9.99 USD`, `Monthly`
   - Click **Save product**
   - **Copy the Price ID** (starts with `price_...`) → save as `STRIPE_PRICE_MONTHLY`

3. Create **"Faux Spy Master Spy (Yearly)"**:
   - Name: `Faux Spy - Master Spy`
   - Pricing: `Recurring`, `$99.00 USD`, `Yearly`
   - Click **Save product**
   - **Copy the Price ID** → save as `STRIPE_PRICE_YEARLY`

### 1.3 Get API Keys

1. Dashboard → **Developers** → **API keys**
2. Copy **Secret key** (starts with `sk_test_...` for test mode)
3. Save as `STRIPE_SECRET_KEY`

> 💡 **Test mode is fine** for now. Switch to live mode later when ready.

---

## Part 2: Buy Your Domain (5 min)

### 2.1 Purchase fauxspy.com

1. Go to [namecheap.com](https://namecheap.com) (cheapest option)
2. Search for `fauxspy.com`
3. Add to cart, complete checkout (~$10–15)
4. **Don't configure DNS yet** — we'll do that after Vercel setup

---

## Part 3: Deploy to Vercel (20 min)

### 3.1 Push Code to GitHub

```bash
# In the fauxspy-website folder:
cd fauxspy-website
git init
git add .
git commit -m "Initial commit"

# Create new repo on github.com, then:
git remote add origin https://github.com/yourusername/fauxspy-website.git
git branch -M main
git push -u origin main
```

### 3.2 Connect to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Add New Project**
3. Import your `fauxspy-website` repo
4. **Don't deploy yet** — we need env vars first

### 3.3 Add Environment Variables

In the Vercel project settings → **Environment Variables**, add:

| Variable | Value | Where to find it |
|----------|-------|------------------|
| `STRIPE_SECRET_KEY` | `sk_test_...` | Stripe dashboard |
| `STRIPE_PRICE_MONTHLY` | `price_...` | Stripe → Products |
| `STRIPE_PRICE_YEARLY` | `price_...` | Stripe → Products |
| `SITE_URL` | `https://fauxspy.com` | Your domain |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Set in Step 4 below |

> ⚠️ Add `STRIPE_WEBHOOK_SECRET` as a placeholder for now. We'll get the real value in Step 4.

### 3.4 Deploy!

1. Click **Deploy**
2. Wait ~2 minutes
3. You'll get a URL like `fauxspy-website.vercel.app`
4. **Visit it** — your landing page should be live! 🎉

---

## Part 4: Set Up Stripe Webhook (10 min)

The webhook is how Stripe tells your backend "hey, someone just paid!" so you can generate their license key.

### 4.1 Create Webhook Endpoint

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. **Endpoint URL:** `https://your-vercel-url.vercel.app/api/webhook`
   - Use your actual Vercel URL (you'll update this to fauxspy.com later)
3. **Events to send** — select these:
   - ✅ `checkout.session.completed`
   - ✅ `customer.subscription.updated`
   - ✅ `customer.subscription.deleted`
   - ✅ `invoice.payment_failed`
4. Click **Add endpoint**
5. **Copy the Signing secret** (starts with `whsec_...`)

### 4.2 Update Vercel with Webhook Secret

1. Vercel project → **Settings** → **Environment Variables**
2. Update `STRIPE_WEBHOOK_SECRET` with the real value
3. **Redeploy** (Deployments tab → click ... → Redeploy)

---

## Part 5: Connect Your Domain (10 min)

### 5.1 Add Domain to Vercel

1. Vercel project → **Settings** → **Domains**
2. Add `fauxspy.com`
3. Add `www.fauxspy.com` (optional but recommended)
4. Vercel will show you DNS records to configure

### 5.2 Configure DNS at Namecheap

1. Login to Namecheap → **Domain List** → **Manage** next to fauxspy.com
2. Click **Advanced DNS**
3. Delete existing records (Parking Page, etc.)
4. Add the records Vercel gave you:
   - Usually: A record `@` → `76.76.21.21`
   - Usually: CNAME `www` → `cname.vercel-dns.com`
5. Save changes
6. Wait 5–60 minutes for DNS to propagate

### 5.3 Update Webhook URL

Once your domain works:
1. Stripe → Webhooks → edit your webhook
2. Change URL from Vercel URL to `https://fauxspy.com/api/webhook`
3. Save

---

## Part 6: Test the Flow (10 min)

### 6.1 Test Checkout

1. Visit `https://fauxspy.com`
2. Click **Start Monthly Plan**
3. Use Stripe test card: `4242 4242 4242 4242`
4. Any future date, any CVC
5. Complete checkout
6. Should redirect to `/success.html`

### 6.2 Verify Webhook

1. Stripe Dashboard → Webhooks → click your endpoint
2. Look at recent events — should see `checkout.session.completed`
3. Click it to see the response (should be 200 OK)
4. Check Vercel logs: project → **Logs** → see your webhook running

### 6.3 Common Issues

**Checkout doesn't work?**
- Check Vercel function logs for errors
- Verify env vars are set correctly
- Make sure price IDs match Stripe

**Webhook fails?**
- Verify webhook secret matches Vercel env var
- Check signing secret hasn't changed

**Domain not working?**
- DNS can take up to 24 hours
- Try `dig fauxspy.com` to check propagation

---

## Part 7: (Optional) Add Database (15 min)

For production, you need to actually save license keys somewhere.

### 7.1 Supabase Setup (Free)

1. Go to [supabase.com](https://supabase.com) → New project
2. Create a `licenses` table:

```sql
CREATE TABLE licenses (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  license_key TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);
```

3. Settings → API → copy `URL` and `service_role` key
4. Add to Vercel env vars:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`

### 7.2 Update webhook.js

Uncomment the Supabase code in `api/webhook.js` and `api/validate-license.js`.

### 7.3 Add Email (Resend)

1. Sign up at [resend.com](https://resend.com)
2. Verify your domain (`fauxspy.com`)
3. Get API key
4. Add to Vercel: `RESEND_API_KEY`
5. Uncomment email code in `webhook.js`

---

## Part 8: Submit Extension to Chrome Web Store (30 min)

> This is separate from the website — the **extension** itself goes here.

### 8.1 Pay Developer Fee

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Pay one-time **$5 developer fee**

### 8.2 Prepare Extension

```bash
cd FauxSpy-v1.0
zip -r fauxspy-extension.zip . -x "*.DS_Store"
```

### 8.3 Submit Listing

1. Click **New Item** → upload zip
2. Fill in store listing:
   - **Name:** Faux Spy - AI Image Detector
   - **Description:** (use copy from BRAND_BOOK.md)
   - **Category:** Productivity
   - **Screenshots:** 5 screenshots at 1280×800
   - **Promo image:** 440×280
   - **Privacy policy URL:** `https://fauxspy.com/privacy`

3. Submit for review (takes 1–7 days)

---

## ✅ Final Checklist

Before going live:

- [ ] Domain works at `https://fauxspy.com`
- [ ] HTTPS enabled (Vercel does this automatically)
- [ ] Stripe checkout works end-to-end
- [ ] Webhook receiving events successfully
- [ ] Privacy & Terms pages accessible
- [ ] Email sending works (if configured)
- [ ] License keys saving to database (if configured)
- [ ] Extension submitted to Chrome Web Store
- [ ] Switched Stripe from test mode to live mode

---

## 🔄 Going Live with Stripe

When ready for real payments:

1. Stripe Dashboard → toggle **Test mode** off (top right)
2. Get **live** API keys (start with `sk_live_...`)
3. Recreate products in **live mode** (test products don't transfer)
4. Update Vercel env vars with live keys + live price IDs
5. Recreate webhook in live mode, get new secret
6. Update `STRIPE_WEBHOOK_SECRET` in Vercel
7. Redeploy

---

## 💰 Cost Breakdown

| Item | Cost |
|------|------|
| Domain (fauxspy.com) | $10–15/year |
| Vercel hosting | Free (hobby plan) |
| Stripe | 2.9% + 30¢ per transaction |
| Supabase (optional) | Free tier |
| Resend (optional) | Free tier (100 emails/day) |
| Chrome Web Store | $5 one-time |
| **Total to launch** | **~$15–20** |

---

## 🆘 Need Help?

**Vercel docs:** [vercel.com/docs](https://vercel.com/docs)  
**Stripe docs:** [stripe.com/docs](https://stripe.com/docs)  
**Chrome extension docs:** [developer.chrome.com](https://developer.chrome.com/docs/extensions)

---

**Ready to ship? You got this. 🕵️**

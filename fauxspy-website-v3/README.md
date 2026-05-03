# 🕵️ Faux Spy Website

Landing page + Stripe backend for Faux Spy Chrome extension.

**Live at:** [fauxspy.com](https://fauxspy.com)

---

## 📁 What's Inside

```
fauxspy-website/
├── index.html          # Landing page
├── styles.css          # Detective theme styling
├── checkout.js         # Stripe checkout button handler
├── success.html        # Post-purchase page
├── privacy.html        # Privacy policy
├── terms.html          # Terms of service
├── logo.png            # Faux Spy logo
├── favicon.png         # Browser favicon
├── api/
│   ├── create-checkout.js   # Creates Stripe Checkout sessions
│   ├── webhook.js           # Handles Stripe webhooks (license generation)
│   └── validate-license.js  # Validates license keys for extension
├── package.json        # Dependencies
├── vercel.json         # Vercel config
├── .env.example        # Environment variable template
└── DEPLOYMENT_GUIDE.md # Full step-by-step deployment guide
```

---

## 🚀 Quick Start

1. **Read the deployment guide:** [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md)
2. **Set up Stripe** (15 min)
3. **Deploy to Vercel** (20 min)
4. **Connect domain** (10 min)
5. **You're live!** 🎉

---

## 💻 Local Development

```bash
# Install Vercel CLI
npm install -g vercel

# Install dependencies
npm install

# Copy env vars
cp .env.example .env.local
# Then fill in your Stripe keys

# Run locally
vercel dev
```

Visit `http://localhost:3000`

---

## 🔧 Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS (no framework needed)
- **Backend:** Vercel Serverless Functions
- **Payments:** Stripe Checkout
- **Hosting:** Vercel
- **Database:** Supabase (optional)
- **Email:** Resend (optional)

---

## 📞 Support

Email: hello@fauxspy.com  
Twitter: [@fauxspy](https://twitter.com/fauxspy)

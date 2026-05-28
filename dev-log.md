# Faux Spy Dev Log

Automatic record of what was built and changed. Updated on every push to main.

## 2026-05-29 — v1.8.8
- Full end-to-end purchase flow audit: verified all API checks, fixed 3 bugs found
- Fixed: license activation in settings.js didn't store token balance (popup showed blank count)
- Fixed: webhook plan detection now explicit for monthly with error logging for unknown price IDs
- Fixed: pro.html checkout now validates Stripe URL before redirect (matches upgrade.js)
- Built dev-tracker agent (this file) + function-audit agent with 12 checks + GitHub Issue escalation

## 2026-05-28 — v1.8.8
- Created og-image.png (1200×630) for Product Hunt launch and social share
- Added webhook idempotency: Redis TTL dedup on Stripe event IDs to prevent double license creation
- Gated dev bypass key `FAUX-DEV0-TEST-ACCS-0001` behind `DEV_LICENSE_ENABLED=true` env var
- Updated schema.org softwareVersion to 1.8.8 in index.html
- Full Stripe setup audit: confirmed all price IDs, webhook, RESEND_API_KEY already in Vercel

## 2026-05-28 — v1.8.8
- Removed "Use your own API keys" feature from extension settings (was competing with Pro subscription)
- Added deepfake/face-swap detection for Pro tier via Sightengine deepfake model
- Relabeled all "Real" verdicts to "No AI Detected" (honest about detection capability)
- Added amber manipulation warning banner on result panel for real/manipulated images
- Fixed sensitivity dropdown not saving in extension settings page
- Fixed status message hide bug across all status elements
- Fixed free tier copy: showed 20 investigations per day, should be 10
- Packaged extension as faux-spy-v1.8.8.zip for Chrome Web Store upload

## 2026-05-27 — v1.8.7
- Blog agent improvements: prompt caching (90% cost reduction), internal link injection
- Blog agent: auto-generates FAQ section from SerpAPI "People Also Ask" results with FAQPage schema
- Blog agent: auto-generates new topics via Claude Haiku when static topic list is exhausted
- Fixed Instagram carousel navigation: close result panel when swiping to next photo
- Fixed misleading "Verified Real" verdict for head-swapped/composited photos

## 2026-05-26 — v1.8.7
- Fixed universal SPA navigation reset for X (Twitter), Instagram, and Pinterest
- Resolved result panel staying open when navigating between posts

## 2026-05-25 — v1.8.6
- Fixed wrong image being scanned after YouTube SPA navigation
- Added dev license key bypass for testing (FAUX-DEV0-TEST-ACCS-0001)
- Fixed settings page sensitivity dropdown save flow + all status message hide bugs

## 2026-05-24 — v1.8.5
- Added video widget close button and settings toggle to show/hide video analyze button
- Fixed video button scroll visibility (button was hidden when scrolled)
- Added free plan upgrade prompt when free users click Analyze Video

## 2026-05-22 — v1.8.4
- Fixed detection of video poster images as videos on X/Twitter
- Fixed upgrade prompt for free users trying to use video detection

## 2026-05-20 — v1.8.3
- Added AI video detection for Pro + Video tier (Sora, Runway, Pika, Veo)
- Added Case Files history page for Pro users to review past scans
- Added Detective Noir dark theme (navy + gold) across all extension UI

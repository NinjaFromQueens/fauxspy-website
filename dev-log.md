# Faux Spy Dev Log

Automatic record of what was built and changed. Updated on every push to main.

## 2026-05-29
- Updated launch email and Product Hunt page with a 30% discount code
- Fixed GitHub issue commenting workflow to use separate comment and close commands
- Improved CI pipeline to skip manifest validation when extension code isn't available

## 2026-05-28
- Added dev-tracker and function-audit agents for enhanced monitoring capabilities
- Improved pro page with updated features and enhanced blog agent functionality
- Fixed webhook plan detection and added URL validation to pro.html
- Prepared for launch with og-image support, webhook idempotency, and developer key gating
- Fixed promo code handling to show errors to users instead of charging full price
- Added dev-tracker and function-audit AI agents for enhanced capabilities
- Improved pro page with better plan detection and URL validation
- Enhanced blog agent functionality
- Prepared for launch with og-image support, webhook reliability, and dev key protection
- Added Pro plan + Video waitlist signup forms for users to join
- Fixed promo code handling to show errors instead of charging full price
- Launched new dev-tracker and function-audit AI agents
- Updated Pro page and improved blog agent functionality
- Added launch prep features including og-images, webhook idempotency, and dev key gating
- Added Pro plan + Video waitlist signup form for users to join
- Improved promo code handling to show users when discounts fail to apply
- Added two new AI agents: dev-tracker and function-audit for extended capabilities
- Fixed Pro page URL validation and webhook plan detection for reliability
- Prepared for launch with OG images, webhook idempotency, and dev key gating
- Added Pro plan and video waitlist signup forms
- Fixed billing issues where promo code failures weren't shown to users
- Launched new AI agents for dev-tracker and function-audit capabilities
- Improved Pro page with webhook idempotency and better plan detection
- Fixed issue with GitHub comment posting in automation workflows

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

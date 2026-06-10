# Faux Spy Dev Log

Automatic record of what was built and changed. Updated on every push to main.

## 2026-06-10
- Improved image detection reliability using dual-engine system with Hive as primary detector
- Added Sightengine as supplementary detection engine for better accuracy
- Fixed crash issues in detection system that was causing errors and spam alerts
- Added a new quiz page at /try-it with interactive demo content
- Enhanced homepage with demo section featuring images
- Implemented dual-engine detection system using Hive and Sightengine
- Fixed crashes and reduced error logging spam in detection module

## 2026-06-09
- Added 9 competitor comparison and alternative product pages
- Fixed homepage canonical tag and updated version to 1.8.9
- Improved image processing by following redirects before analysis
- Fixed error code handling in image processing responses
- Added error monitoring to backend with Sentry integration
- Improved content detection with dual-engine system using Hive and Sightengine
- Added comparisons with 9 competitors and alternative product pages
- Fixed redirect handling before content analysis to resolve error codes
- Enhanced error tracking and monitoring with Sentry integration
- Fixed SEO and technical issues including canonical tags and workflow errors

## 2026-06-08
- Fixed redirect handling to ensure proper URL resolution before content moderation checks
- Improved error code forwarding for better error reporting and debugging
- Resolved issues affecting content analysis reliability (issues #1201 and #1044)
- Added error monitoring to the backend using Sentry
- Fixed redirect handling before checking images with Sightengine
- Improved error code forwarding for issues #1201 and #1044
- Fixed YAML syntax error in the automated page generation workflow
- Added error monitoring to the backend using Sentry to track issues
- Improved redirect handling and error reporting for image analysis
- Updated the extension to version 1.8.9
- Fixed image analysis errors by following redirects before processing
- Fixed website publishing workflow

## 2026-06-02
- Added founder bio and E-E-A-T author credibility signals to blog posts
- Standardized all website URLs to www.fauxspy.com for better search indexing
- Fixed missing Dataset name field and corrected citation schema types
- Resolved structured data errors reported by Google Search Console
- Restored About page content that was accidentally deleted
- Added founder information and author credibility details to the About page
- Standardized all website URLs to www.fauxspy.com for search engine consistency
- Fixed structured data errors in Dataset schema and citation types
- Improved search engine visibility through proper content organization and metadata

## 2026-05-31
- Built email inbox feature to receive and display past emails from Resend
- Fixed email webhook parsing and storage so admin panel can access received emails
- Improved inbox UI styling and added debugging tools for email reception
- Fixed database issues with orphaned data cleanup during backfill process
- Improved SEO with canonicals, sitemaps, and meta descriptions
- Fixed SEO issues including canonicals, noindex tags, sitemap, and meta descriptions
- Added structured data (BreadcrumbList schema and publisher logo) to blog posts
- Built inbox feature to receive and display emails with backfill for past messages
- Switched from Vercel KV to Upstash Redis for better reliability
- Fixed inbox styling, error handling, and webhook payload parsing
- Added web analytics tracking and improved search engine visibility across all public pages
- Fixed Google indexing issues with proper canonical tags, metadata, and sitemap configuration
- Built email inbox feature to receive and display past emails with improved panel styling
- Fixed data processing and API infrastructure to handle email ingestion without hitting function limits
- Improved email webhook parsing and added debugging tools for API response inspection
- Added Ahrefs web analytics tracking to all 38 public pages
- Improved SEO with canonicals, sitemaps, meta descriptions, and schema markup
- Fixed inbox email backfill to import past received emails and improve panel styling
- Replaced analytics and database services (Ahrefs script loader, Upstash Redis)
- Fixed data processing to handle orphaned dedup keys and stay within function limits
- Added 77 new landing pages with programmatic SEO and UI improvements
- Integrated Ahrefs web analytics across all public pages
- Fixed Google indexing issues with canonicals, noindex tags, and sitemap
- Added schema markup (BreadcrumbList and publisher logo) to blog posts
- Built inbox backfill feature to import past received emails from Resend
- Improved inbox email detail panel styling and debugging tools
- Built 136 landing pages and 28 blog posts using programmatic SEO
- Fixed Google indexing issues with proper canonicals, noindex tags, and sitemap
- Added analytics tracking and BreadcrumbList schema to all public pages
- Improved inbox email detail panel styling and debugging capabilities
- Optimized backend to stay within serverless function limits
- Built 136 landing pages and 28 blog posts using programmatic SEO generation
- Added analytics tracking (Ahrefs) across all public pages
- Improved search engine visibility with schema markup, canonicals, sitemaps, and meta descriptions
- Enhanced blog discoverability with internal linking and statistics hub
- Fixed data pipeline issues to stay within deployment limits and handle orphaned records
- Added analytics tracking and improved Google indexing with schema markup
- Reduced bounce rate through conversion optimization across all pages
- Improved blog discoverability with internal linking and statistics hub
- Fixed data synchronization issues by clearing orphaned deduplication keys
- Added analytics tracking and monitoring across all public pages
- Improved search engine visibility with structured data, sitemaps, and canonicals
- Enhanced internal linking and created a statistics hub for better discoverability
- Optimized homepage and mid-content calls-to-action to reduce bounce rate
- Built 136 landing pages and 28 blog posts with programmatic SEO
- Improved website discoverability through internal linking and schema markup
- Enhanced analytics tracking with Ahrefs web analytics across all pages
- Optimized bounce rate and conversion with homepage improvements and mid-content CTAs
- Fixed sitemap submission to dynamically include all 149 URLs instead of 37 hardcoded ones

## 2026-05-30
- Launched Product Hunt with a blog agent feature
- Added senior safety content cluster
- Fixed styling issues with blog cards
- Weekly newsletter system added with signup, management, and broadcast features
- Product Hunt launch blog post and senior safety content published
- Blog card styling improvements for better visual presentation
- Weekly newsletter system added with signup, agent, and broadcast functionality
- Newsletter endpoint consolidated with waitlist to work within platform limits
- Product Hunt launch blog agent and senior safety content cluster created
- Blog card styling improved for better presentation
- Added email reply functionality in the admin panel for managing inbox
- Launched a weekly newsletter system with signup, automated agent, and broadcast capabilities
- Published Product Hunt launch blog post and senior safety content cluster
- Improved blog card styling and visual presentation
- Consolidated newsletter and waitlist features into a single endpoint to optimize function usage
- Added email reply functionality in the admin panel inbox
- Fixed bugs with inbox replies, unread counters, and email styling
- Launched a weekly newsletter system with signup and broadcast features
- Published Product Hunt launch blog and senior safety content
- Consolidated newsletter and waitlist endpoints to optimize backend limits
- Added weekly newsletter system with signup, distribution, and management in admin panel
- Implemented email reply functionality in the admin inbox for managing messages
- Fixed inbox display bugs including unread counter and message stat accuracy
- Consolidated newsletter and waitlist into a single endpoint for better resource management
- Added Product Hunt launch blog content and improved blog card styling
- Email reply functionality added to the admin panel inbox
- Inbox message counter fixed to display correct unread counts
- Weekly newsletter system launched with signup and broadcast features
- Webhook signature verification added for Resend email service
- Email viewer styling and reply error handling improved
- Product Hunt launch blog and safety content added
- Email reply functionality added to admin panel inbox
- Weekly newsletter system launched with signup and broadcast capabilities
- Webhook handling improved to support Resend inbound webhooks
- Fixed inbox display bugs including stat counter and unread message tracking
- Blog agent and content clustering features added for Product Hunt launch
- Added email reply functionality to the admin panel inbox
- Implemented weekly newsletter system with signup, automation, and broadcasts
- Fixed inbox display issues including unread counter and message statistics
- Added webhook signature verification for Resend inbound emails
- Improved admin panel by syncing inbox data to Vercel KV storage
- Created PH launch blog agent and senior safety content cluster
- Built a weekly newsletter system with signup, automated agent, and broadcast capabilities
- Fixed inbox display issues including error handling, unread counters, and styling
- Improved webhook handling for Resend inbound emails with proper signature verification
- Created a PH launch blog agent and senior safety content cluster
- Built a weekly newsletter system with signup, automated agent, and broadcast functionality
- Added email reply capability in the admin panel inbox with error handling and styling fixes
- Implemented Resend inbound webhook support with signature verification and proper payload parsing
- Switched from Vercel KV to Upstash Redis for better reliability across API routes
- Fixed inbox display bugs including unread counter accuracy and admin panel data persistence
- Added ability to backfill past emails received through Resend into the inbox
- Implemented email reply functionality in the admin panel inbox
- Fixed inbox display to show email count and handle errors from webhook parsing
- Switched from Vercel KV to Upstash Redis for storing inbox data
- Added signature verification for Resend inbound webhooks and support for unsigned webhooks
- Added ability to reply to emails directly in the admin panel inbox
- Implemented email inbox backfill to import past emails received via Resend
- Fixed inbox to properly display received emails and handle webhook signatures
- Improved styling and fixed bugs in email detail panel and unread counter
- Switched from Vercel KV to Upstash Redis for more reliable data storage
- Added ability to backfill and import past emails received through Resend into the inbox
- Fixed inbox to properly display email details, unread counts, and reply functionality
- Improved email detail panel styling and error handling for better user experience
- Switched from Vercel KV to Upstash Redis for more reliable data storage across API routes
- Added webhook signature verification for Resend inbound emails to ensure security
- Added inbox feature to receive and display past emails from Resend
- Fixed inbox webhook handling to properly parse Resend inbound emails and show errors
- Improved inbox email detail panel styling and stat display
- Added debug action to inspect incoming email API responses
- Added inbox feature to store and display past emails received via Resend inbound webhooks
- Implemented backfill functionality to import historical Resend emails into the inbox
- Fixed inbox email detail panel styling and error handling for better UX
- Replaced Vercel KV with Upstash Redis for more reliable data persistence
- Added debug tooling to inspect incoming webhook API responses

## 2026-05-29
- Updated launch email and Product Hunt page with a 30% discount code
- Fixed GitHub issue commenting workflow to use separate comment and close commands
- Improved CI pipeline to skip manifest validation when extension code isn't available
- Fixed email broadcast functionality by switching to Resend REST API
- Fixed GitHub issue commenting workflow in CI/CD process
- Resolved manifest validation check that was failing in CI environment
- Added owner copy and audience size validation to launch email to prevent sending to empty lists
- Switched to Resend REST API for broadcast emails due to SDK limitations
- Updated launch email and Product Hunt page with 30% off promotional code
- Fixed GitHub issue commenting workflow to properly add comments and close issues
- Improved CI reliability by skipping manifest validation when extension repo isn't available
- Fixed Product Hunt URL and set up automated launch emails to send every other day for 2 weeks
- Improved launch email with owner copy option and audience size validation to prevent sending to empty lists
- Switched to Resend REST API for broadcast emails to work around SDK limitations
- Added Product Hunt 30% discount code to launch email and product page
- Fixed GitHub issue automation to properly comment and close issues separately
- Fixed launch email issues including owner copy and audience size validation
- Set up automated launch email sending every other day for 2 weeks
- Added Product Hunt 30% discount code to launch email and PH page
- Switched to Resend REST API for email broadcasts due to SDK limitations
- Improved CI pipeline to skip manifest checks for extension repository
- Set up automated launch email campaigns to be sent every other day for 2 weeks
- Fixed launch email issues including audience validation and missing owner copy
- Added Faux Spy explainer section to the launch email
- Updated Product Hunt URL and added 30% discount code to launch materials
- Fixed email broadcast delivery using Resend REST API instead of SDK
- Added a prominent Chrome Web Store install button to the launch email
- Created an explainer section in the launch email introducing Faux Spy
- Fixed multiple issues found in launch email audit
- Scheduled automated launch emails to send every other day for 2 weeks
- Added a Product Hunt 30% discount code to launch email and promotional page
- Configured launch email campaign to send daily through June 12 (14 total sends)
- Added Chrome Web Store install button and Faux Spy explainer to launch email
- Fixed multiple issues found in launch email audit and audience configuration
- Added ProductHunt 30% off promotional code to launch email and product page
- Updated all website URLs to use www.fauxspy.com domain
- Launched email campaign with daily sends through mid-June (14 emails total)
- Added prominent Chrome Web Store install button and explainer section to launch email
- Fixed multiple issues in launch email and added audience verification
- Created Product Hunt page with 30% off promotional code

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

# Faux Spy Dev Log

Automatic record of what was built and changed. Updated on every push to main.

## 2026-10-21
- Added 7-day Pro trial and upgraded Stripe integration with Managed Payments
- Paused Pro and Video sales while fixing video detection issues
- Fixed video detection to properly read Sightengine API responses
- Improved billing by using dedicated portal config and separating product checkouts
- Added clearer messaging when video checks are temporarily unavailable
- Added 7-day Pro trial and upgraded to Stripe Managed Payments for billing
- Fixed video detection to properly read API responses from Sightengine
- Paused Pro and Video sales temporarily until video detection is working reliably
- Improved clarity by explicitly showing when video checks are unavailable
- Set up dedicated billing portal and isolated product checkouts in shared Stripe account
- Added webhook support for handling asynchronous payment events
- Added 7-day Pro trial and improved payment processing with Stripe Managed Payments
- Paused Pro and Video sales until video detection reliability improves
- Fixed video detection to correctly read API responses and show clear status messages
- Improved outreach and Reddit bot features to require approval before sending
- Separated billing portal configuration for better account management

## 2026-09-21
- Fixed newsletter unsubscribe functionality to work correctly with Resend's email service
- Enforced the unsubscribe link to properly display and function in emails

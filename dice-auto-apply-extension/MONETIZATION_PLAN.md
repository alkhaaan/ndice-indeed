# Monetization Plan

## Current Reality
This repository now includes extension-side subscription handling:
- Free plan usage tracking
- Starter, Pro, and Unlimited plan gating for higher daily limits
- Upgrade and billing portal buttons
- License/subscription validation hook for a Stripe-backed service

The extension still needs the live hosted billing service and Stripe configuration before real payments can be processed.

## Best Revenue Model
Use a free Chrome Web Store listing plus a paid external service.

Current model:
- Free tier: local profile autofill, logs, manual review before submit, 10 live applications per day
- Starter monthly: $9.99/month for 100 live applications per day
- Pro monthly: $22.99/month for 450 live applications per day
- Unlimited monthly: $35.99/month for unlimited live applications, subject to fair-use protections
- Future paid features: advanced profile templates, multi-profile support, exportable application history, premium support, cloud backup, agency/team features

## Minimum Commercial Stack Needed
- Marketing site
- privacy policy and terms pages
- billing provider such as Stripe
- account or license system
- hosted subscription validation endpoint
- webhook processing for Stripe subscription lifecycle
- configured checkout and customer portal URLs

## Recommended Positioning
- Target tech job seekers who actively use Dice
- Avoid promising blind auto-submit
- Emphasize speed, review, logs, and privacy
- Expand later to more ATS systems only after the Dice version proves demand

## Fastest Path
1. Publish a compliant free version.
2. Measure installs, retention, and user feedback.
3. Build a paid companion web service only if real usage appears.

## Revenue Outlook
- As a Dice-only tool, revenue potential is niche and likely modest.
- A profitable outcome is more plausible if it becomes:
  - a broader ATS autofill product
  - a recruiter/agency workflow tool
  - a premium job-search assistant with hosted services

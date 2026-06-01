# Chrome Web Store Listing Draft

## Name
NDice Indeed

## Summary
Autofills supported Dice application flows and keeps detailed logs for review.

## Description
NDice Indeed helps streamline repetitive Dice application workflows.

It can:
- Run on a schedule at 3 random local times each day (never between 11:00 PM and 5:00 AM local time)
- Open Dice job listings and autofill supported Easy Apply flows
- Keep detailed logs so you can review outcomes and improve settings over time
- Support dry-run mode for safe testing before live use
- Pause and resume the scheduler from the popup
- Stop before final submission so you can review and confirm
- Use a Free plan with 10 live applications per day
- Upgrade to Starter, Pro, or Unlimited monthly plans for higher daily limits

Key features:
- Scheduled automation using Chrome alarms
- Per-job result tracking and run summaries
- Detailed logs for troubleshooting and iteration
- Profile autofill for common application fields
- Free/Starter/Pro/Unlimited subscription status with external Stripe-backed billing
- Safer handling for manual-review cases such as uploads, unsupported forms, or explicit submit confirmation

Important notes:
- This extension is designed for Dice pages only
- Website UI changes can affect automation behavior
- Some jobs still require manual review
- Use responsibly and in accordance with Dice terms and your local requirements

## Category
Productivity

## Single Purpose
Autofill supported Dice Easy Apply job application flows and log the results for review before final submission.

## Permissions Justification
- `storage`: saves settings, job history, and logs locally in Chrome
- `alarms`: runs the scheduled automation windows
- `tabs`: opens Dice job tabs and closes them after processing
- `scripting`: injects the content script when needed on Dice pages
- `https://*.dice.com/*`: limits automation access to Dice pages only
- `https://ndice-indeed-billing.onrender.com/*`: opens billing pages and validates subscription status

## Privacy Disclosure Draft
This extension stores configuration, logs, job history, billing email, and license key locally in the user's browser storage. It interacts with Dice pages needed to automate supported autofill flows and contacts the NDice Indeed subscription service only for checkout, billing management, and subscription validation. It does not include analytics.

## Store Assets Still Needed
- 128x128 extension icon PNG
- At least 1 screenshot, ideally 3 to 5
- Optional small promo tile for better listing presentation

## Suggested Screenshots
- Popup with schedule and profile settings
- Status area showing run summary and controls
- Logs page showing recent automation history

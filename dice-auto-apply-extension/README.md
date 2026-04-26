# Dice Application Autofill Assistant (Chrome Extension)

## What it does
- Runs automation on Dice job search pages.
- Manual run mode uses your currently open Dice search results page.
- Opens each listed job in a new tab, autofills supported application steps, and stops for final review before submission.
- Scheduled daily runs in Eastern Time at:
  - 9:00 AM ET
  - 1:00 PM ET
  - 6:00 PM ET
- Saves detailed logs so you can review failures and improve rules.
- Supports dry-run mode for safe testing.
- Uses a review-first workflow for the final submit step.

## Files
- `manifest.json`: Extension config (MV3)
- `background.js`: Scheduler, orchestration, per-job tab pipeline, storage, logs
- `dice-content.js`: Search-page job collection + single-job autofill logic on dice.com
- `popup.html/js/css`: Controls for settings and manual run
- `logs.html/js/css`: Full log review and JSON export

## Install (Unpacked)
1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `dice-auto-apply-extension`.

## First-time setup
1. Open your Dice search results page with your desired filters.
2. Open extension popup.
3. Add profile fields (name, email, phone, etc.) for autofill.
4. Optionally enable `Dry run` first.
5. Click `Save`.
6. Click `Run now`.

## Log-driven improvement loop
1. Open `Open logs` from popup.
2. Review entries with `warn` and `error`.
3. Look for recurring statuses:
   - `manual_review_required`
   - `not_easy_apply`
   - `apply_button_missing`
   - `tab_flow_error`
4. Improve selectors or fill-rules in `dice-content.js`.
5. Re-test in dry-run mode.

## Notes
- Dice UI changes can break selectors; logging is included to spot these quickly.
- Some applications require uploads, custom questions, or explicit submit confirmation and may still need manual review.
- Use responsibly and in line with dice.com terms and your local requirements.

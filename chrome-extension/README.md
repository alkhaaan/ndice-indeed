# Indeed Auto Apply Assistant (Chrome Extension)

## What it does
- Runs automation on Indeed search results pages.
- Scheduled daily runs in Eastern Time at:
  - 9:00 AM ET
  - 1:00 PM ET
  - 6:00 PM ET
- Saves detailed logs so you can review failures and improve rules.
- Supports manual runs from the popup.
- Supports dry-run mode for safe testing.

## Files
- `manifest.json`: Extension config (MV3)
- `background.js`: Scheduler, orchestration, storage, logs
- `indeed-content.js`: In-page automation logic on indeed.com
- `popup.html/js/css`: Controls for settings and manual run
- `logs.html/js/css`: Full log review and JSON export

## Install (Unpacked)
1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `chrome-extension`.

## First-time setup
1. Open extension popup.
2. Set `Indeed Search URL` with your desired filters.
3. Add profile fields (name, email, phone, etc.) for autofill.
4. Optionally enable `Dry run` first.
5. Click `Save`.
6. Click `Run now` to verify behavior.

## Log-driven improvement loop
1. Open `Open logs` from popup.
2. Review entries with `warn` and `error`.
3. Look for recurring statuses:
   - `manual_review_required`
   - `non_easy_apply_or_unavailable`
   - `Maximum form step limit reached`
4. Improve selectors or fill-rules in `indeed-content.js`.
5. Re-test in dry-run mode.

## Notes
- Website UI changes can break selectors; logging is included to spot these quickly.
- Some applications require uploads or custom questions and may still need manual review.
- Use responsibly and in line with Indeed terms and your local requirements.

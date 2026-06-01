# NDice Indeed QA Report (2026-05-31)

## Scope
- Extension package quality for Chrome Web Store release.
- Reliability, security, privacy, UX, and monetization readiness.

## Automated Checks Executed
- `node --check background.js` pass
- `node --check popup.js` pass
- `node --check dice-content.js` pass

## Reliability QA
- Run lock and stale lock recovery path: present
- Stop-request behavior path: present
- Content script reinjection on channel failure: present
- BFCache/message channel closure fallback handling: present
- Pagination determinism: present
- Settings hard-clamp in backend and popup:
  - max jobs per run: 1..100
  - max listing pages: 1..25
  - max form steps: 1..30

## Security QA
- No `eval` or dynamic code execution
- Logs rendering uses DOM text nodes
- Host permissions are constrained to Dice and NDice Indeed billing endpoints

## Data & Privacy QA
- Local storage model documented
- Billing email and license key storage documented
- Subscription validation endpoint use documented
- Job history retention cap: 5000 entries
- Logs retention cap: 1500 entries

## Subscription Readiness
- Plan gating is implemented at 10 Free, 100 Starter, 450 Pro, and Unlimited live applications per local day.
- Starter, Pro, and Unlimited monthly gating is implemented for higher daily application limits.
- Checkout, customer portal, subscription refresh, cached plan state, and 72-hour grace period handling are implemented.
- Before real production billing, connect live Stripe checkout/customer portal URLs, a hosted validation endpoint, and webhook processing.

## Final Release Gate
- Core extension reliability/security: pass with low residual risk
- Chrome Web Store listing readiness: pass after final billing URLs and assets are confirmed
- Subscription extension-side readiness: pass

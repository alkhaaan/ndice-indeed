# NDice Indeed QA Report (2026-05-13)

## Scope
- Extension package quality for Chrome Web Store release.
- Reliability, security, privacy, UX, and monetization readiness.

## Automated Checks Executed
- `node --check background.js` ✅ pass
- `node --check popup.js` ✅ pass
- `node --check dice-content.js` ✅ pass
- `rg` scans for risky patterns (`eval`, `fetch`, `innerHTML`, message contracts) ✅ pass with notes

## Reliability QA
- Run lock and stale lock recovery path: present ✅
- Stop-request behavior path: present ✅
- Content script reinjection on channel failure: present ✅
- BFCache/message channel closure fallback handling: present ✅
- Pagination determinism (start page 1 + page-by-page collection): present ✅
- Settings hard-clamp in backend and popup:
  - max jobs per run (1..100) ✅
  - max listing pages (1..25) ✅
  - max form steps (1..30) ✅

## Security QA
- No `eval` / dynamic code execution ✅
- No remote HTTP data exfiltration in code ✅
- Logs rendering now uses DOM text nodes (no row `innerHTML`) ✅
- Host permissions constrained to `https://*.dice.com/*` ✅

## Data & Privacy QA
- Local-only storage model documented ✅
- Added job-history retention cap (5000 entries) to prevent unbounded growth ✅
- Logs capped at 1500 entries ✅

## Store Policy Readiness
- Single purpose appears consistent with code ✅
- Permission justification doc exists ✅
- Privacy notice exists ✅
- Remaining store assets required (screenshots/promo media) ⚠️ pending

## Subscription Readiness (Important)
- In-extension subscription billing is **not implemented** ❌
- Required for production subscriptions:
  1. Backend account system (user identity + entitlement API)
  2. Payment processor integration (e.g., Stripe)
  3. Webhook processing for subscription lifecycle (active, past_due, canceled)
  4. Extension license check + cached grace period handling
  5. Terms/Privacy updates for billing and account data

## Remediation Implemented in This QA Pass
- Backend + popup limits hard-clamped.
- Search URL normalization hardened.
- Messaging resilience for collect/apply paths.
- Job-history retention pruning added.
- Logs page hardened to avoid HTML-template row insertion.

## Final Release Gate
- Core extension reliability/security: **PASS with low residual risk**
- Chrome Web Store listing readiness: **PASS after assets completion**
- Subscription monetization readiness: **NOT READY** (backend/billing phase required)

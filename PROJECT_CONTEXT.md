# Dice Auto Apply - Working Context

Last updated: 2026-05-13

## Current Status

- Core automation is running successfully on fresh Chrome/Dice profiles.
- Recent successful run:
  - `runId`: `1778713084729-lwp0yo`
  - `trigger`: manual
  - `totalProcessed`: 48
  - `submitted`: 39
  - `skipped`: 9
  - `manualReviewRequired`: 0
  - `errors`: 0
- Logging now shows healthy end-to-end flow (discover -> open tab -> submit -> close tab -> summary).

## Fixes Already Applied

1. Stale lock recovery hardening
- Prevents indefinite `inProgress` lock after browser restart.
- Startup now forces stale run lock recovery.

2. Dice discovery reliability improvements
- Added stronger job-card filtering.
- Added robust anchor fallback for `/job-detail/` and `jobId=` URLs.
- Improved collection where pages may include non-job containers.

3. Guardrails and limits
- Input clamping in settings/runtime:
  - `maxJobsPerRun`: 1..100
  - `maxPaginationPages`: 1..25
  - `maxFormSteps`: 1..30

4. Safety/quality
- Log rendering hardened to avoid unsafe HTML rendering.
- Job history pruning added to avoid unbounded storage growth.

## Product Direction (Agreed)

- Publish to Chrome Web Store.
- Monetization model:
  - Free tier: target around 25 applications/day.
  - Pro tier: around `$8.99` / month for unlimited usage.
- Payment provider: Stripe.

## What is still needed from owner before launch

1. Chrome Web Store publisher/account details.
2. Stripe keys, price IDs, webhook signing secret.
3. Privacy Policy URL, Terms URL, Refund policy.
4. Auth choice for paid users (recommended: Google Sign-In).
5. Listing assets/content (name, description, icons, screenshots).


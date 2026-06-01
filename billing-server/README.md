# NDice Indeed Billing Server

This server connects NDice Indeed subscriptions to your Stripe account.

Money goes to the Stripe account that owns `STRIPE_SECRET_KEY`. To receive payouts, that Stripe account must be in live mode, fully onboarded, and connected to your bank account in Stripe Dashboard.

## Required Stripe Setup

1. Create or sign in to your Stripe account.
2. Complete business verification and add your bank account under Stripe payout settings.
3. Create product: `NDice Indeed`.
4. Create three recurring monthly prices:
   - Starter: `$9.99`
   - Pro: `$22.99`
   - Unlimited: `$35.99`
5. Copy the live Price IDs into `STRIPE_STARTER_MONTHLY_PRICE_ID`, `STRIPE_PRO_MONTHLY_PRICE_ID`, and `STRIPE_UNLIMITED_MONTHLY_PRICE_ID`.
6. Copy your live secret key into `STRIPE_SECRET_KEY`.
7. Deploy this server at `https://ndiceindeed.com`.
8. Add a Stripe webhook endpoint:
   - `https://ndiceindeed.com/stripe/webhook`
9. Subscribe the webhook to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
10. Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`.

## Local Run

```bash
npm install
copy .env.example .env
npm run dev
```

Use Stripe test keys locally. Use live keys only on the production server.

## Extension URLs

The extension is already configured for:

- `https://ndiceindeed.com/billing/checkout`
- `https://ndiceindeed.com/billing/portal`
- `https://ndiceindeed.com/api/subscription/validate`

Checkout receives the selected plan, user's billing email, and generated license key from the extension. Webhooks store the Stripe customer, subscription ID, and plan against that license key. The extension then calls the validation endpoint to unlock Starter, Pro, or Unlimited access.

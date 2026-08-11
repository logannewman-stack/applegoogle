// Billing — deliberately unplugged.
//
// Northstar is free right now: no tiers, no premium results, no locked
// features. This file is the documented seam for the eventual business
// model, which is a simple subscription — never advertising, never paid
// placement, never selling data. Nothing here is routed by the API today.
//
// When the time comes:
//   1. Define real plans below and expose them via GET /v1/plans.
//   2. Implement createCheckoutSession with Stripe Checkout.
//   3. Activate subscriptions from the checkout.session.completed webhook.
//   4. Whatever the plan gates, it must never be ranking — INTEGRITY.md and
//      test/ranker.test.js hold regardless of who is paying.

export const DRAFT_PLANS = {
  monthly: { id: 'monthly', priceUsd: 8, interval: 'month' },
  annual: { id: 'annual', priceUsd: 80, interval: 'year' },
};

export async function createCheckoutSession() {
  throw Object.assign(
    new Error('Payments are not wired up — Northstar is free right now. See src/api/billing.js for the future seam.'),
    { status: 501, code: 'payments_not_configured' },
  );
}

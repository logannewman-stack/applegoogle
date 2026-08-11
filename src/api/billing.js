// Subscriptions — the only revenue in the product, by design.
//
// There is deliberately no advertising module for this file to talk to.
// The pricing model is: pay for the service, and the service answers to you,
// not to advertisers.
//
// Payment processing is NOT wired up yet. Activation currently uses the
// 'dev-manual' provider so the whole flow can be built and tested end to end.
// When ready to charge real money, implement `createCheckoutSession` with
// Stripe (or similar) and flip activation to happen in the payment webhook.

export const PLANS = {
  monthly: {
    id: 'monthly',
    name: 'Monthly',
    priceUsd: 8,
    interval: 'month',
    description: 'Effectively unlimited search. Cancel any time.',
  },
  annual: {
    id: 'annual',
    name: 'Annual',
    priceUsd: 80,
    interval: 'year',
    description: 'Two months free versus monthly.',
  },
};

export function publicPlans() {
  return {
    plans: Object.values(PLANS),
    principles: [
      'Subscriptions are the only source of revenue.',
      'No advertising. No sponsored results. No paid ranking — there is no mechanism for it.',
      'If you stop paying, you fall back to the free tier; your data is not sold either way.',
    ],
  };
}

export function subscribe(user, planId) {
  const plan = PLANS[planId];
  if (!plan) {
    throw Object.assign(new Error(`Unknown plan '${planId}'. Available: ${Object.keys(PLANS).join(', ')}.`), {
      status: 400,
      code: 'unknown_plan',
    });
  }
  const now = new Date();
  const renews = new Date(now);
  if (plan.interval === 'month') renews.setMonth(renews.getMonth() + 1);
  else renews.setFullYear(renews.getFullYear() + 1);

  user.plan = 'subscriber';
  user.subscription = {
    planId: plan.id,
    status: 'active',
    provider: 'dev-manual', // replace with 'stripe' once payments are wired in
    startedAt: now.toISOString(),
    currentPeriodEnd: renews.toISOString(),
  };
  return user.subscription;
}

export function cancelSubscription(user) {
  if (!user.subscription || user.subscription.status !== 'active') {
    throw Object.assign(new Error('No active subscription to cancel.'), { status: 400, code: 'not_subscribed' });
  }
  user.subscription.status = 'canceled';
  user.subscription.canceledAt = new Date().toISOString();
  user.plan = 'free';
  return user.subscription;
}

// The seam where a real payment provider plugs in.
export async function createCheckoutSession() {
  throw Object.assign(
    new Error(
      'Payment processing is not configured yet. Wire a Stripe Checkout session here, ' +
        'activate the subscription from the checkout.session.completed webhook, and remove the dev-manual provider.',
    ),
    { status: 501, code: 'payments_not_configured' },
  );
}

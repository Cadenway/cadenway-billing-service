import type { StripeSubscriptionDecision } from '../../value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeSubscriptionReconciliation } from '../../value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';

/** The storage grant applied to a Team subscription. */
export const teamStorageByteLimit = 100_000_000_000;

/** Keeps the effective Team seat allowance at least as large as the Free allowance. */
export function effectiveTeamSeatLimit(paidQuantity: number, freeSeatLimit: number): number {
  return Math.max(paidQuantity, freeSeatLimit);
}

/**
 * Resolves the self-service entitlement from the current bound Stripe subscription. The
 * [Stripe lifecycle](https://docs.stripe.com/api/subscriptions/object#subscription_object-status)
 * keeps a subscription active or trialing until a scheduled cancellation takes effect. Billing
 * reads the current Stripe subscription for each reconciliation because webhook order is arbitrary.
 * Organisation › Facturation sets Team storage at 100 GB. A provider-confirmed cancellation
 * returns a previously paid subscription to the Free limits once both quota owners support that
 * transition. The quota owners keep existing resources and check new admissions against the limit.
 */
export function resolveStripeSubscription({
  binding,
  settings,
  subscription,
}: StripeSubscriptionReconciliation): StripeSubscriptionDecision {
  if (
    subscription.liveMode !== settings.liveMode ||
    subscription.customerId.length === 0 ||
    subscription.subscriptionId.length === 0 ||
    subscription.customerId !== binding.customerId ||
    subscription.subscriptionId !== binding.subscriptionId
  ) {
    return { kind: 'ignore', reason: 'binding-mismatch' };
  }

  const { status } = subscription;
  if (status === 'incomplete') {
    return { kind: 'ignore', reason: 'initial-payment-pending' };
  }

  if (status === 'canceled') {
    const { freePlanLimits } = settings;
    if (!settings.freeReturnEnabled) return { kind: 'reconcile', reason: 'free-return-disabled' };
    if (
      !isPositiveInteger(freePlanLimits.seats) ||
      !isPositiveInteger(freePlanLimits.storageBytes)
    ) {
      return { kind: 'reconcile', reason: 'invalid-free-allowance' };
    }
    return { kind: 'apply', plan: 'free', limits: { ...freePlanLimits } };
  }

  if ((status !== 'active' && status !== 'trialing') || subscription.collectionPaused) {
    return { kind: 'reconcile', reason: 'unresolved-status' };
  }

  const [item] = subscription.items;
  if (
    subscription.hasMoreItems ||
    subscription.items.length !== 1 ||
    item === undefined ||
    item.priceId.length === 0 ||
    !settings.teamPriceIds.includes(item.priceId) ||
    !isPositiveInteger(item.quantity)
  ) {
    return { kind: 'reconcile', reason: 'unexpected-team-items' };
  }

  return {
    kind: 'apply',
    plan: 'team',
    limits: {
      seats: effectiveTeamSeatLimit(item.quantity, settings.freePlanLimits.seats),
      storageBytes: teamStorageByteLimit,
    },
    scheduledCancellation: subscription.scheduledCancellation,
  };
}

function isPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

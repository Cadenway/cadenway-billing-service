import type { StripeSubscriptionDecision } from '../../value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeSubscriptionReconciliation } from '../../value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';

/** The storage grant applied to a Team subscription. */
export const teamStorageByteLimit = 100_000_000_000;

/** Keeps the effective Team seat allowance at least as large as the Free allowance. */
export function effectiveTeamSeatLimit(paidQuantity: number, freeSeatLimit: number): number {
  return Math.max(paidQuantity, freeSeatLimit);
}

/**
 * Resolves the self-service Team entitlement from an allowlisted Stripe subscription. The
 * [Stripe lifecycle](https://docs.stripe.com/api/subscriptions/object#subscription_object-status)
 * keeps a subscription active or trialing until a scheduled cancellation takes effect. Billing
 * reads the current Stripe subscription for each reconciliation because webhook order is arbitrary.
 * Organisation › Facturation sets Team storage at 100 GB and only allows a downgrade when the
 * organization fits in the new plan. The application must revalidate the binding and any reduced
 * allowance before persisting this decision. A webhook payload alone provides none of that proof.
 */
export function resolveStripeSubscription({
  binding,
  settings,
  subscription,
  confirmedUsage,
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
  const entitled = status === 'active' || status === 'trialing';
  const ended = status === 'canceled' || status === 'incomplete_expired';
  if ((!entitled && !ended) || (entitled && subscription.collectionPaused)) {
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

  if (entitled) {
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

  const { freePlanLimits } = settings;
  if (
    confirmedUsage === null ||
    !isCounter(confirmedUsage.seats) ||
    !isCounter(confirmedUsage.storageBytes) ||
    !isPositiveInteger(freePlanLimits.seats) ||
    !isPositiveInteger(freePlanLimits.storageBytes)
  ) {
    return { kind: 'reconcile', reason: 'free-quota-unverified' };
  }
  if (
    confirmedUsage.seats > freePlanLimits.seats ||
    confirmedUsage.storageBytes > freePlanLimits.storageBytes
  ) {
    return { kind: 'reconcile', reason: 'free-quota-exceeded' };
  }
  return { kind: 'apply', plan: 'free', limits: { ...freePlanLimits } };
}

function isPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

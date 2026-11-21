import { describe, expect, it } from 'vitest';

import type { StripeSubscriptionReconciliation } from '../../value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';

import { resolveStripeSubscription } from './stripe-subscription.policy.js';

const binding = { customerId: 'cus_atelier_nord', subscriptionId: 'sub_atelier_nord' };
const settings = {
  liveMode: false,
  teamPriceIds: ['price_team_fixture'],
  freePlanLimits: { seats: 5, storageBytes: 2_000_000_000 },
};
const currentSubscription = {
  ...binding,
  liveMode: false,
  status: 'active',
  scheduledCancellation: false,
  collectionPaused: false,
  hasMoreItems: false,
  items: [{ priceId: 'price_team_fixture', quantity: 18 }],
};
const atTheFreeLimit = { seats: 5, storageBytes: 2_000_000_000 };

function reconcile(
  subscription: Partial<StripeSubscriptionReconciliation['subscription']> = {},
  confirmedUsage: StripeSubscriptionReconciliation['confirmedUsage'] = null,
) {
  return resolveStripeSubscription({
    binding,
    settings,
    subscription: { ...currentSubscription, ...subscription },
    confirmedUsage,
  });
}

describe('Stripe subscription reconciliation', () => {
  it.each(['active', 'trialing'])('uses the licensed Team seat quantity while %s', (status) => {
    expect(reconcile({ status })).toEqual({
      kind: 'apply',
      plan: 'team',
      limits: { seats: 18, storageBytes: 100_000_000_000 },
      scheduledCancellation: false,
    });
  });

  it('retains Team until a scheduled cancellation is reflected in the current status', () => {
    expect(reconcile({ scheduledCancellation: true })).toEqual({
      kind: 'apply',
      plan: 'team',
      limits: { seats: 18, storageBytes: 100_000_000_000 },
      scheduledCancellation: true,
    });
  });

  it.each([1, 2, 3, 4, 5])(
    'maintains the Free seat allowance for a Team subscription with %s paid seats',
    (quantity) => {
      expect(reconcile({ items: [{ priceId: 'price_team_fixture', quantity }] })).toEqual({
        kind: 'apply',
        plan: 'team',
        limits: { seats: 5, storageBytes: 100_000_000_000 },
        scheduledCancellation: false,
      });
    },
  );

  it('accepts a configured annual Team price in a live Stripe account', () => {
    expect(
      resolveStripeSubscription({
        binding,
        settings: { ...settings, liveMode: true, teamPriceIds: ['price_monthly', 'price_annual'] },
        subscription: {
          ...currentSubscription,
          liveMode: true,
          items: [{ priceId: 'price_annual', quantity: 1 }],
        },
        confirmedUsage: null,
      }),
    ).toMatchObject({ kind: 'apply', plan: 'team', limits: { seats: 5 } });
  });

  it.each(['canceled', 'incomplete_expired'])(
    'selects the documented Free allowance after %s only when usage fits',
    (status) => {
      expect(reconcile({ status }, atTheFreeLimit)).toEqual({
        kind: 'apply',
        plan: 'free',
        limits: { seats: 5, storageBytes: 2_000_000_000 },
      });
    },
  );

  it.each([
    { seats: 6, storageBytes: 2_000_000_000 },
    { seats: 5, storageBytes: 2_000_000_001 },
  ])('defers a Free downgrade when current usage exceeds either Free limit', (usage) => {
    expect(reconcile({ status: 'canceled' }, usage)).toEqual({
      kind: 'reconcile',
      reason: 'free-quota-exceeded',
    });
  });

  it.each([null, { seats: -1, storageBytes: 0 }, { seats: 1, storageBytes: Number.NaN }])(
    'requires complete valid usage before applying Free (%s)',
    (usage) => {
      expect(reconcile({ status: 'canceled' }, usage)).toEqual({
        kind: 'reconcile',
        reason: 'free-quota-unverified',
      });
    },
  );

  it.each([
    { customerId: 'cus_other' },
    { subscriptionId: 'sub_previous_checkout' },
    { liveMode: true },
  ])('ignores a canonical response outside the stored binding and configured mode', (snapshot) => {
    expect(reconcile(snapshot)).toEqual({ kind: 'ignore', reason: 'binding-mismatch' });
  });

  it('refuses missing provider identifiers even when the empty binding matches', () => {
    const missingBinding = { customerId: '', subscriptionId: '' };
    expect(
      resolveStripeSubscription({
        binding: missingBinding,
        settings,
        subscription: { ...currentSubscription, ...missingBinding },
        confirmedUsage: null,
      }),
    ).toEqual({ kind: 'ignore', reason: 'binding-mismatch' });
  });

  it('ignores the subscription while its initial payment is incomplete', () => {
    expect(reconcile({ status: 'incomplete' })).toEqual({
      kind: 'ignore',
      reason: 'initial-payment-pending',
    });
  });

  it.each(['past_due', 'unpaid', 'paused', 'future-status'])(
    'defers entitlement changes for %s',
    (status) => {
      expect(reconcile({ status })).toEqual({ kind: 'reconcile', reason: 'unresolved-status' });
    },
  );

  it('does not infer paid entitlement from active status while invoice collection is paused', () => {
    expect(reconcile({ collectionPaused: true })).toEqual({
      kind: 'reconcile',
      reason: 'unresolved-status',
    });
  });

  it.each([
    { hasMoreItems: true },
    { items: [] },
    { items: [...currentSubscription.items, { priceId: 'price_other', quantity: 1 }] },
    { items: [{ priceId: 'price_other', quantity: 18 }] },
  ])('requires exactly one complete, allowlisted Team price item', (snapshot) => {
    expect(reconcile(snapshot)).toEqual({ kind: 'reconcile', reason: 'unexpected-team-items' });
  });

  it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a malformed provider seat quantity (%s)',
    (quantity) => {
      expect(reconcile({ items: [{ priceId: 'price_team_fixture', quantity }] })).toEqual({
        kind: 'reconcile',
        reason: 'unexpected-team-items',
      });
    },
  );

  it('defers a terminal snapshot from a different price before considering a downgrade', () => {
    expect(
      reconcile(
        { status: 'canceled', items: [{ priceId: 'price_other', quantity: 1 }] },
        atTheFreeLimit,
      ),
    ).toEqual({ kind: 'reconcile', reason: 'unexpected-team-items' });
  });
});
